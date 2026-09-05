/**
 * Host-side connectivity probe over the `searxng-probe` settings section.
 *
 * Channel design (deliberately boring): the card writes a probe *request*
 * into its own settings section and the host writes the *result* back.
 * Both halves already talk settings fluently (the main `searxng` section),
 * so this reuses only proven primitives — no host↔client RPC, which the
 * client platform does not offer to third-party plugins (namespace property
 * access on `ctx.remote` is gated by fiber injects third-party entries
 * cannot satisfy; observed as `cannot get property "remote.X" without
 * inject` across unrelated third-party plugins too).
 *
 * Why the probe runs on the host at all: the browser cannot reuse the host
 * egress proxy (`proxyUrl`, e.g. socks5h) and community instances generally
 * do not send CORS headers — the probe must run where `search()` runs.
 *
 * Protocol (all section values are flat scalars; target/result lists ride
 * JSON-encoded strings so any settings backend round-trips them):
 * - client sets `targetsJson` (array of `{url,username?,password?,
 *   categories?,language?,safesearch?}`), `proxyUrl`, `timeoutMs`, then
 *   `requestId` LAST with a fresh id. Passwords ride here with the same
 *   sensitivity as the main section (see `config.ts`); they are never logged.
 * - host `onChange` fires per commit; it acts only when `requestId` is
 *   non-empty and differs from `resultId`, fans the targets out in parallel
 *   (one real search each, `maxResults: 3`, bounded timeout), then
 *   `settings.update()`s `{resultId, resultsJson, error}`.
 * - client matches `resultId === requestId`; anything else (including a
 *   host that predates this section) surfaces as timeout/unsupported hints,
 *   never silence.
 *
 * A failed probe is a *normal outcome* (`ok: false` per target), never a
 * thrown error — only a malformed request produces section-level `error`.
 */

import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { SearxngSearchProvider } from "./provider.js";
import { isValidProxyUrl } from "./dispatcher.js";

/** Settings namespace carrying probe requests and results. */
export const PROBE_NS = "searxng-probe" as const;

export const ProbeSectionSchema: any = z.object({
  /** Fresh id per round, written LAST by the client. "" = idle. */
  requestId: z.string(),
  /** JSON array of ProbeTarget. Cap enforced host-side. */
  targetsJson: z.string(),
  /** Egress proxy shared by the round (http/https/socks5(h)). "" = direct. */
  proxyUrl: z.string(),
  /** Per-target timeout ms, clamped host-side to 3–30s. */
  timeoutMs: z.number(),
  /** requestId this result answers. "" = none yet. */
  resultId: z.string(),
  /** JSON array of ProbeTargetResult. */
  resultsJson: z.string(),
  /** Round-level failure (e.g. malformed request). "" = none. */
  error: z.string(),
});

export interface ProbeSection {
  requestId: string;
  targetsJson: string;
  proxyUrl: string;
  timeoutMs: number;
  resultId: string;
  resultsJson: string;
  error: string;
}

export interface ProbeTarget {
  url: string;
  username?: string;
  password?: string;
  categories?: string;
  language?: string;
  safesearch?: number;
}

export interface ProbeTargetResult {
  url: string;
  ok: boolean;
  latencyMs: number;
  resultCount: number;
  firstTitle?: string;
  firstUrl?: string;
  /** Machine-readable for known cases, else the raw provider error. */
  error?: string;
}

export const PROBE_DEFAULT_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MIN_MS = 3_000;
const PROBE_TIMEOUT_MAX_MS = 30_000;
const PROBE_MAX_TARGETS = 12;
const PROBE_QUERY = "test";

export const probeSectionEntry: ProbeSection = {
  requestId: "",
  targetsJson: "[]",
  proxyUrl: "",
  timeoutMs: PROBE_DEFAULT_TIMEOUT_MS,
  resultId: "",
  resultsJson: "[]",
  error: "",
};

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
  if (!Array.isArray(parsed)) throw new Error("targetsJson must be a JSON array");
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

/**
 * Install the probe section: watch for fresh requestIds, fan out, write back.
 * Mirrors the main section's setSource/current pattern in `index.ts`.
 */
export function installProbeSection(ctx: Context, settings: SettingsProvider): void {
  let current: () => ProbeSection = () => ({ ...probeSectionEntry });
  // Round ids already running: intermediate commits of a multi-field client
  // write must not start duplicate runs for the same requestId.
  const running = new Set<string>();

  const maybeRun = (cfg: ProbeSection): void => {
    // Act on any requestId we have not answered yet. Overlapping rounds
    // (e.g. manual test during an auto-probe batch) each write their own
    // resultId; waiters match by id, so every round always writes.
    if (!cfg.requestId || cfg.requestId === cfg.resultId || running.has(cfg.requestId)) return;
    running.add(cfg.requestId);
    const snapshot = { ...cfg };
    void runRound(settings, ctx, snapshot)
      .catch((err) => {
        ctx.logger.warn(`[searxng] probe round failed: ${String(err)}`);
      })
      .finally(() => {
        running.delete(snapshot.requestId);
      });
  };

  settings.installSection(
    ctx,
    PROBE_NS,
    ProbeSectionSchema as unknown as Parameters<typeof settings.installSection>[2],
    { ...probeSectionEntry } as unknown,
    {
      validate(value: unknown) {
        const v = value as ProbeSection;
        for (const k of ["requestId", "targetsJson", "proxyUrl", "resultId", "resultsJson", "error"] as const) {
          if (typeof v[k] !== "string") throw new Error(`searxng-probe: ${k} must be a string`);
        }
        if (typeof v.timeoutMs !== "number" || !Number.isFinite(v.timeoutMs)) {
          throw new Error("searxng-probe: timeoutMs must be a number");
        }
      },
      setSource(next: () => ProbeSection) {
        current = next as () => ProbeSection;
      },
      onChange() {
        try {
          maybeRun(current());
        } catch (err) {
          ctx.logger.warn(`[searxng] probe change rejected: ${String(err)}`);
        }
      },
    },
  );
}

async function runRound(settings: SettingsProvider, ctx: Context, cfg: ProbeSection): Promise<void> {
  const requestId = cfg.requestId;
  let targets: ProbeTarget[];
  try {
    targets = parseTargets(cfg.targetsJson);
  } catch (err) {
    await settings.update(PROBE_NS, {
      resultId: requestId,
      resultsJson: "[]",
      error: err instanceof Error ? err.message : String(err),
    } as unknown as object);
    return;
  }
  const timeoutMs = Math.min(Math.max(cfg.timeoutMs || PROBE_DEFAULT_TIMEOUT_MS, PROBE_TIMEOUT_MIN_MS), PROBE_TIMEOUT_MAX_MS);
  const proxyUrl = cfg.proxyUrl || "";
  ctx.logger.info(`[searxng] probe round ${targets.length} target(s) timeout=${timeoutMs}ms proxy=${proxyUrl ? "set" : "direct"}`);
  const results = await Promise.all(targets.map((t) => probeOne(t, proxyUrl, timeoutMs)));
  const okCount = results.filter((r) => r.ok).length;
  ctx.logger.info(`[searxng] probe round done ok=${okCount}/${results.length}`);
  await settings.update(PROBE_NS, {
    resultId: requestId,
    resultsJson: JSON.stringify(results),
    error: "",
  } as unknown as object);
}
