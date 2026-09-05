import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { SearxngSearchProvider } from "./provider.js";
import type { SearxngOptions } from "./provider.js";
import { installProbeSection } from "./probe.js";
import {
  SearxngSettings,
  assertServiceable,
  redactBaseURL,
  redactProxyUrl,
  SEARXNG_DEFAULT_CATEGORIES,
  SEARXNG_DEFAULT_LANGUAGE,
  SEARXNG_DEFAULT_SAFESEARCH,
  type SearxngSettings as SettingsType,
} from "./config.js";

/** Cordis 插件名（loader 诊断用） */
export const name = "web-searxng";
/** 注入 ctx.web 缝合服务（settings 走 ctx.inject 可选接入，缺席不影响搜索） */
export const inject = ["web"];

/** 插件配置（全可选 —— apply 内用 env / 常量回填，与 exa 插件一致） */
export interface Config {
  /** SearXNG 实例地址。回退到 `$SEARXNG_BASE_URL`。为空 → provider 不可用。 */
  baseURL?: string;
  /** Caddy BasicAuth 用户名。回退到 `$SEARXNG_USERNAME`。留空 = 无鉴权（公用实例）。 */
  username?: string;
  /** Caddy BasicAuth 密码。回退到 `$SEARXNG_PASSWORD`。 */
  password?: string;
  /** SearXNG categories 参数。默认 `general`。 */
  categories?: string;
  /** SearXNG language 参数。默认 `zh-CN`。 */
  language?: string;
  /** SearXNG safesearch 参数（0/1/2）。默认 `1`。 */
  safesearch?: number;
  /** 出境代理。回退 `$SEARXNG_PROXY_URL` → `$HTTPS_PROXY` → `$ALL_PROXY`。留空 = 直连。 */
  proxyUrl?: string;
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  username: z.string(),
  password: z.string(),
  categories: z.string(),
  language: z.string(),
  safesearch: z.number().step(1).min(0).max(2),
  proxyUrl: z.string(),
});

/** settings namespace（与 client 卡片 key 一致） */
const NS = "searxng" as const;

export function apply(ctx: Context, config: Config) {
  const env = launchEnvironmentOf(ctx);
  const envStr = (key: string): string | undefined => {
    const v = env.get(key)?.value;
    return typeof v === "string" ? v : undefined;
  };

  // Composition entry → settings base：全字段归一化，bare {} 可用。
  // 代理 env 链：显式 SEARXNG_PROXY_URL 优先，其次通用 HTTPS_PROXY / ALL_PROXY。
  const proxyFromEnv =
    envStr("SEARXNG_PROXY_URL") ??
    envStr("HTTPS_PROXY") ?? envStr("https_proxy") ??
    envStr("ALL_PROXY") ?? envStr("all_proxy");
  let normalizedEntry: SettingsType;
  try {
    normalizedEntry = {
      baseURL: config.baseURL ?? envStr("SEARXNG_BASE_URL") ?? "",
      username: config.username ?? envStr("SEARXNG_USERNAME") ?? "",
      password: config.password ?? envStr("SEARXNG_PASSWORD") ?? "",
      categories: config.categories ?? SEARXNG_DEFAULT_CATEGORIES,
      language: config.language ?? SEARXNG_DEFAULT_LANGUAGE,
      safesearch: config.safesearch ?? SEARXNG_DEFAULT_SAFESEARCH,
      proxyUrl: config.proxyUrl ?? proxyFromEnv ?? "",
    };
    assertServiceable(normalizedEntry);
  } catch (err) {
    ctx.logger.warn(`[searxng] composition config invalid: ${String(err)}`);
    normalizedEntry = {
      baseURL: "",
      username: "",
      password: "",
      categories: SEARXNG_DEFAULT_CATEGORIES,
      language: SEARXNG_DEFAULT_LANGUAGE,
      safesearch: SEARXNG_DEFAULT_SAFESEARCH,
      proxyUrl: "",
    };
  }

  // Live provider opts：provider 每次 search 按需读取，onChange 原地更新即可，
  // 无需 dispose + 重注册。
  const liveOpts: SearxngOptions = { ...normalizedEntry };
  const syncLiveOpts = (s: SettingsType): void => {
    liveOpts.baseURL = s.baseURL;
    liveOpts.username = s.username;
    liveOpts.password = s.password;
    liveOpts.categories = s.categories;
    liveOpts.language = s.language;
    liveOpts.safesearch = s.safesearch;
    liveOpts.proxyUrl = s.proxyUrl;
  };

  // Authoritative source：settings 层 attach 前是 entry，之后是 resolved scope。
  // installSettingsSection 调 setSource 先于匹配的 onChange，无需轮询。
  let current: () => SettingsType = () => normalizedEntry;

  ctx.web.registerSearchProvider(new SearxngSearchProvider(liveOpts));

  // Settings namespace — live, validated, layered over entry.
  // ctx.inject 可选接入：dsh-settings 缺席时只有搜索（entry 配置），不断插件。
  const installSettings = (settingsService: SettingsProvider): void => {
    settingsService.installSection(
      ctx,
      NS,
      SearxngSettings as unknown as Parameters<typeof settingsService.installSection>[2],
      normalizedEntry as unknown,
      {
        validate(value: unknown) {
          assertServiceable(value as SettingsType);
        },
        setSource(next: () => SettingsType) {
          current = next as () => SettingsType;
        },
        onChange() {
          try {
            const cfg = current();
            assertServiceable(cfg);
            syncLiveOpts(cfg);
            ctx.logger.info(
              `[searxng] config applied: baseURL=${cfg.baseURL ? redactBaseURL(cfg.baseURL) : "(unconfigured)"} ` +
                `auth=${cfg.username ? "basic" : "none"} categories=${cfg.categories} ` +
                `language=${cfg.language} safesearch=${cfg.safesearch} ` +
                `proxy=${cfg.proxyUrl ? redactProxyUrl(cfg.proxyUrl) : "direct"}`,
            );
          } catch (err) {
            ctx.logger.warn(`[searxng] settings change rejected: ${String(err)}`);
          }
        },
      },
    );
  };

  ctx.inject(["settings"], (settingsCtx: { settings: SettingsProvider }) => {
    installSettings(settingsCtx.settings);
    // Connectivity probe channel for the settings card (request/response
    // over the `searxng-probe` section — see probe.ts).
    installProbeSection(ctx, settingsCtx.settings);
  });
}
