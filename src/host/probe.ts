/** Probe execution. */

import type { Context } from "@deepseek-ai/cordis";
import { SearxngSearchProvider } from "./provider.js";
import { isValidProxyUrl } from "./dispatcher.js";
import { PROBE_DEFAULT_TIMEOUT_MS, type ProbeTarget, type ProbeTargetResult } from "./config.js";

export const PROBE_MAX_TARGETS = 12;
const PROBE_TIMEOUT_MIN_MS = 3_000;
const PROBE_TIMEOUT_MAX_MS = 30_000;
const PROBE_QUERY = "test";

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseTargets(raw: string): ProbeTarget[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("probeTargetsJson must be a JSON array");
  return parsed.slice(0, PROBE_MAX_TARGETS).map((t) => {
    if (typeof t !== "object" || t === null) throw new Error("probe target must be an object");
    const r = t as Record<string, unknown>;
    if (typeof r.url !== "string" || r.url.length === 0) throw new Error("probe target.url must be a non-empty string");
    const str = (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string) : undefined);
    const num = (k: string): number | undefined =>
      typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : undefined;
    const username = str("username");
    const password = str("password");
    const categories = str("categories");
    const language = str("language");
    const safesearch = num("safesearch");
    return {
      url: r.url,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(categories ? { categories } : {}),
      ...(language ? { language } : {}),
      ...(safesearch !== undefined ? { safesearch } : {}),
    };
  });
}

export async function probeOne(
  target: ProbeTarget,
  proxyUrl: string,
  timeoutMs: number,
): Promise<ProbeTargetResult> {
  const t0 = Date.now();
  if (!isHttpUrl(target.url)) {
    return { url: target.url, ok: false, latencyMs: 0, resultCount: 0, error: "invalid-url" };
  }
  if (proxyUrl && !isValidProxyUrl(proxyUrl)) {
    return { url: target.url, ok: false, latencyMs: 0, resultCount: 0, error: "invalid-proxy" };
  }
  const provider = new SearxngSearchProvider({
    baseURL: target.url,
    ...(target.username ? { username: target.username } : {}),
    ...(target.password ? { password: target.password } : {}),
    categories: target.categories || "general",
    language: target.language || "zh-CN",
    safesearch: target.safesearch ?? 1,
    ...(proxyUrl ? { proxyUrl } : {}),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const ret = await provider.search({ query: PROBE_QUERY, maxResults: 3 }, ctrl.signal);
    const first = ret.sources[0];
    return {
      url: target.url,
      ok: true,
      latencyMs: Date.now() - t0,
      resultCount: ret.sources.length,
      ...(first?.title ? { firstTitle: first.title } : {}),
      ...(first ? { firstUrl: first.url } : {}),
    };
  } catch (e) {
    return {
      url: target.url,
      ok: false,
      latencyMs: Date.now() - t0,
      resultCount: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run a probe round and write its result. */
export async function runProbeRound(
  ctx: Context,
  cfg: { probeRequestId: string; probeTargetsJson: string; probeProxyUrl: string; probeTimeoutMs: number },
  writeBack: (patch: object) => Promise<unknown>,
): Promise<void> {
  const requestId = cfg.probeRequestId;
  let targets: ProbeTarget[];
  try {
    targets = parseTargets(cfg.probeTargetsJson);
  } catch (err) {
    await writeBack({
      probeResultId: requestId,
      probeResultsJson: "[]",
      probeError: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const timeoutMs = Math.min(Math.max(cfg.probeTimeoutMs || PROBE_DEFAULT_TIMEOUT_MS, PROBE_TIMEOUT_MIN_MS), PROBE_TIMEOUT_MAX_MS);
  const proxyUrl = cfg.probeProxyUrl || "";
  ctx.logger.info(`[searxng] probe round ${targets.length} target(s) timeout=${timeoutMs}ms proxy=${proxyUrl ? "set" : "direct"}`);
  const results = await Promise.all(targets.map((t) => probeOne(t, proxyUrl, timeoutMs)));
  const okCount = results.filter((r) => r.ok).length;
  ctx.logger.info(`[searxng] probe round done ok=${okCount}/${results.length}`);
  await writeBack({
    probeResultId: requestId,
    probeResultsJson: JSON.stringify(results),
    probeError: "",
  });
}
