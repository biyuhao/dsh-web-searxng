import type { Context } from "@deepseek-ai/cordis";
// Loader event types.
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

/** Plugin name. */
export const name = "web-searxng";
/** Injected web service. */
export const inject = ["web"];
export { Config } from "./config.js";

/** Settings namespace. */
const NS = "searxng" as const;

/** Optional settings write-back face. */
type SettingsFace = { update?: (ns: string, patch: object) => Promise<unknown> };

/** Parse a boolean environment flag. */
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

  // Loader values fall back to environment variables.
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

  // Validate at startup; bad values fail per request.
  try {
    assertServiceable(current());
  } catch (err) {
    ctx.logger.warn(`[searxng] composition config invalid: ${String(err)}`);
  }

  // Keep provider options live.
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

  // Probe/refresh protocol: write request, then write result.
  let writeBack: ((patch: object) => Promise<unknown>) | undefined;
  const probeRunning = new Set<string>();
  const refreshRunning = new Set<string>();
  // Stop retrying failed round IDs.
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
    // Read the optional settings face.
    const face = (settingsCtx as unknown as { settings?: SettingsFace }).settings;
    if (typeof face?.update !== "function") return;
    writeBack = (patch) => face.update!(NS, patch);
    // Handle pending requests after restart.
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
      // Keep serving after a bad committed value.
      ctx.logger.warn(`[searxng] config change rejected: ${String(err)}`);
    }
    scanProtocol();
  });
}
