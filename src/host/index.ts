import type { Context } from "@deepseek-ai/cordis";
// 类型副作用：引入 loader 的事件声明（loader/volatile-update）。
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { SearxngSearchProvider } from "./provider.js";
import type { SearxngOptions } from "./provider.js";
import { runProbeRound } from "./probe.js";
import { runRefreshRound } from "./instances.js";
import {
  assertServiceable,
  effectiveProxyUrl,
  redactBaseURL,
  redactProxyUrl,
  SEARXNG_DEFAULT_CATEGORIES,
  SEARXNG_DEFAULT_LANGUAGE,
  SEARXNG_DEFAULT_SAFESEARCH,
  type SearxngConfigRef,
  type SearxngBase,
} from "./config.js";

/** Cordis 插件名（loader 诊断用） */
export const name = "web-searxng";
/** 注入 ctx.web 缝合服务 */
export const inject = ["web"];
export { Config } from "./config.js";

/** settings namespace（与 client 卡片 key、loader entry id 一致） */
const NS = "searxng" as const;

/** 回写 face：settings 服务缺席（纯 entry 配置部署）时通道静默停用。 */
type SettingsFace = { update?: (ns: string, patch: object) => Promise<unknown> };

/** 解析 SEARXNG_PROXY_ENABLED 之类的开关 env：0/false/no/off/disabled → false，其余非空 → true，缺省 undefined。 */
function parseEnabledFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (["0", "false", "no", "off", "disabled", "disable"].includes(v)) return false;
  return true;
}

export function apply(ctx: Context, config: SearxngConfigRef) {
  const env = launchEnvironmentOf(ctx);
  const envStr = (key: string): string | undefined => {
    const v = env.get(key)?.value;
    return typeof v === "string" ? v : undefined;
  };

  // 每个字段是 Loader 原地提交的 volatile 引用；env 回填在快照之上做覆盖层
  // （entry 字段留空时生效）。代理 env 链：显式 SEARXNG_PROXY_URL 优先，其次
  // 通用 HTTPS_PROXY / ALL_PROXY。
  const proxyFromEnv =
    envStr("SEARXNG_PROXY_URL") ??
    envStr("HTTPS_PROXY") ?? envStr("https_proxy") ??
    envStr("ALL_PROXY") ?? envStr("all_proxy");
  const proxyEnabledFromEnv = parseEnabledFlag(envStr("SEARXNG_PROXY_ENABLED"));
  const current = (): SearxngBase => ({
    baseURL: config.baseURL.get() || envStr("SEARXNG_BASE_URL") || "",
    username: config.username.get() || envStr("SEARXNG_USERNAME") || "",
    password: config.password.get() || envStr("SEARXNG_PASSWORD") || "",
    categories: config.categories.get() || SEARXNG_DEFAULT_CATEGORIES,
    language: config.language.get() || SEARXNG_DEFAULT_LANGUAGE,
    safesearch: config.safesearch.get() ?? SEARXNG_DEFAULT_SAFESEARCH,
    proxyUrl: config.proxyUrl.get() || proxyFromEnv || "",
    proxyEnabled: config.proxyEnabled.get() ?? proxyEnabledFromEnv ?? true,
  });

  // schema 表达不了的跨字段校验。新架构无法拒绝已提交的写入，这里只做启动
  // 期诊断（软失败：坏值在每次请求时给出 per-request 错误，不拖垮整个插件）。
  try {
    assertServiceable(current());
  } catch (err) {
    ctx.logger.warn(`[searxng] composition config invalid: ${String(err)}`);
  }

  // Live provider opts：provider 每次 search 按需读取，配置提交后原地更新
  // 即可，无需 dispose + 重注册。
  const liveOpts: SearxngOptions = { ...current() };
  const syncLiveOpts = (cfg: SearxngBase): void => {
    liveOpts.baseURL = cfg.baseURL;
    liveOpts.username = cfg.username;
    liveOpts.password = cfg.password;
    liveOpts.categories = cfg.categories;
    liveOpts.language = cfg.language;
    liveOpts.safesearch = cfg.safesearch;
    liveOpts.proxyUrl = cfg.proxyUrl;
    liveOpts.proxyEnabled = cfg.proxyEnabled;
  };

  ctx.effect(() => ctx.web.registerSearchProvider(new SearxngSearchProvider(liveOpts)), "searxng: search provider");

  // ── probe/instances 通道（card ↔ host，字段即信令） ─────────────────────
  // 卡片把请求写进本 entry Config 的 probe*/refresh* 字段（requestId LAST），
  // volatile 提交触发本事件；host 经 settings.update 回写，回写自身因
  // resultId === requestId 守卫不再重跑。settings 缺席时通道静默停用。
  let writeBack: ((patch: object) => Promise<unknown>) | undefined;
  const probeRunning = new Set<string>();
  const refreshRunning = new Set<string>();
  // 回写失败的轮次 id 记为终态：否则未应答的 id 会在后续每个事件上重跑整轮。
  let probeDeadId = "";
  let refreshDeadId = "";
  const scanProtocol = (): void => {
    if (!writeBack) return;
    const probeRequestId = config.probeRequestId.get();
    if (
      probeRequestId &&
      probeRequestId !== config.probeResultId.get() &&
      probeRequestId !== probeDeadId &&
      !probeRunning.has(probeRequestId)
    ) {
      probeRunning.add(probeRequestId);
      const snapshot = {
        probeRequestId,
        probeTargetsJson: config.probeTargetsJson.get(),
        probeProxyUrl: config.probeProxyUrl.get(),
        probeTimeoutMs: config.probeTimeoutMs.get(),
      };
      void runProbeRound(ctx, snapshot, writeBack)
        .catch((err) => {
          probeDeadId = probeRequestId;
          ctx.logger.warn(`[searxng] probe round failed: ${String(err)}`);
        })
        .finally(() => probeRunning.delete(probeRequestId));
    }
    const refreshRequestId = config.refreshRequestId.get();
    if (
      refreshRequestId &&
      refreshRequestId !== config.refreshResultId.get() &&
      refreshRequestId !== refreshDeadId &&
      !refreshRunning.has(refreshRequestId)
    ) {
      refreshRunning.add(refreshRequestId);
      const snapshot = { refreshRequestId, instancesProxyUrl: config.instancesProxyUrl.get() };
      void runRefreshRound(ctx, snapshot, writeBack)
        .catch((err) => {
          refreshDeadId = refreshRequestId;
          ctx.logger.warn(`[searxng] instances refresh round failed: ${String(err)}`);
        })
        .finally(() => refreshRunning.delete(refreshRequestId));
    }
  };

  ctx.inject(["settings"], (settingsCtx: Context) => {
    // settings face 由 dsh-settings 注入（此仓库不依赖其类型，结构化读取）。
    const face = (settingsCtx as unknown as { settings?: SettingsFace }).settings;
    if (typeof face?.update !== "function") return;
    writeBack = (patch) => face.update!(NS, patch);
    // 启动期扫一遍：host 重启后残留的未应答请求在此得到处理。
    scanProtocol();
  });

  const logApplied = (cfg: SearxngBase): void => {
    ctx.logger.info(
      `[searxng] config applied: baseURL=${cfg.baseURL ? redactBaseURL(cfg.baseURL) : "(unconfigured)"} ` +
        `auth=${cfg.username ? "basic" : "none"} categories=${cfg.categories} ` +
        `language=${cfg.language} safesearch=${cfg.safesearch} ` +
        `proxy=${effectiveProxyUrl(cfg) ? redactProxyUrl(effectiveProxyUrl(cfg)) : "direct"}` +
        `${cfg.proxyUrl && !effectiveProxyUrl(cfg) ? " (disabled, kept)" : ""}`,
    );
  };

  ctx.on("loader/volatile-update", () => {
    try {
      const cfg = current();
      assertServiceable(cfg);
      syncLiveOpts(cfg);
      logApplied(cfg);
    } catch (err) {
      // 候选值已提交——warn 并继续服务；此处失败会把卡片整个藏掉。
      ctx.logger.warn(`[searxng] config change rejected: ${String(err)}`);
    }
    scanProtocol();
  });
}
