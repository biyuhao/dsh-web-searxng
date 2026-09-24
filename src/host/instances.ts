/**
 * Host-side community-list refresh round (channel rationale in probe.ts).
 * The card writes a refresh request into the entry Config's `refresh*`
 * fields; the host fetches searx.space, curates the list, and writes it
 * back via `settings.update` as the runtime cache. The bundled snapshot
 * (`src/client/instances.snapshot.json`) stays the offline default. Runs
 * host-side for the same reasons as the probe (no CORS, egress proxy); a
 * failed fetch sets a round-level `refreshError` and leaves the old cache
 * untouched.
 */

import type { Context } from "@deepseek-ai/cordis";
import { fetch as undiciFetch } from "undici";
import { getOrCreateDispatcher, isValidProxyUrl } from "./dispatcher.js";

export type CuratedInstance = {
  url: string;
  status: "up" | "unknown";
  uptimePct: number | null;
  latencyMs: number | null;
  version: string | null;
};

/** Refresh source (overridable for tests) + kept rows. Mirrors scripts/update-instances.mjs. */
export const INSTANCES_SOURCE = "https://searx.space/data/instances.json";
export const INSTANCES_KEEP = 100;
export const INSTANCES_FETCH_TIMEOUT_MS = 30_000;

// --- tolerant searx-stats2 parsing (ported from scripts/update-instances.mjs) ---

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | undefined {
  return typeof v === "object" && v !== null ? (v as Rec) : undefined;
}

function firstPresent(entry: Rec, keys: string[]): unknown {
  for (const k of keys) {
    const v = entry[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function normStatus(v: unknown): "up" | "down" | "unknown" {
  if (v === true || v === 1) return "up";
  if (v === false || v === 0) return "down";
  if (typeof v !== "string") return "unknown";
  const s = v.trim().toLowerCase();
  if (["up", "online", "ok", "success", "true"].includes(s)) return "up";
  if (["down", "offline", "error", "fail", "failed", "false"].includes(s)) return "down";
  return "unknown";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function statusFromStats2(info: Rec): "up" | "down" | "unknown" {
  const timing = asRecord(info.timing);
  const http = asRecord(info.http);
  const httpErr = http ? http.error : undefined;
  if (typeof httpErr === "string" && httpErr.trim() !== "") return "down";
  const initial = timing ? asRecord(timing.initial) : undefined;
  const search = timing ? asRecord(timing.search) : undefined;
  const initPct = initial ? num(initial.success_percentage) : undefined;
  if (initPct === 0) return "down";
  const searchPct = search ? num(search.success_percentage) : undefined;
  const working = search ? num(search.working_engines) : undefined;
  if (searchPct !== undefined && searchPct > 0 && (working === undefined || working > 0)) return "up";
  const legacy = normStatus(firstPresent(info, ["status", "state", "up", "online"]));
  if (legacy !== "unknown") return legacy;
  return "unknown";
}

function healthFromStats2(info: Rec): number | null {
  const timing = asRecord(info.timing);
  const search = timing ? asRecord(timing.search) : undefined;
  const initial = timing ? asRecord(timing.initial) : undefined;
  const s = search ? num(search.success_percentage) : undefined;
  if (s !== undefined) return Math.round(s * 10) / 10;
  const i = initial ? num(initial.success_percentage) : undefined;
  if (i !== undefined) return Math.round(i * 10) / 10;
  const flat = firstPresent(info, ["uptime", "uptimePct"]);
  if (typeof flat === "number" && Number.isFinite(flat)) return Math.round(flat * 10) / 10;
  const r = asRecord(flat);
  if (r) {
    const n = firstPresent(r, ["all", "week", "day", "month"]);
    if (typeof n === "number" && Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

function latencyFromStats2(info: Rec): number | null {
  const timing = asRecord(info.timing);
  for (const key of ["initial", "search"]) {
    const section = timing ? asRecord(timing[key]) : undefined;
    const all = section ? asRecord(section.all) : undefined;
    const v = all ? num(all.value) : undefined;
    if (v !== undefined && v >= 0) return v < 300 ? Math.round(v * 1000) : Math.round(v);
  }
  const ms = firstPresent(info, ["latencyMs", "latency_ms"]);
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const s = firstPresent(info, ["itime", "response_time", "responseTime", "time", "latency"]);
  if (typeof s === "number" && Number.isFinite(s) && s >= 0) {
    return s < 300 ? Math.round(s * 1000) : Math.round(s);
  }
  return null;
}

/** Fetch + curate. Throws on fetch/HTTP/parse failure (caller records refreshError). */
export async function fetchCuratedInstances(
  proxyUrl: string,
  source: string = INSTANCES_SOURCE,
  keep: number = INSTANCES_KEEP,
): Promise<CuratedInstance[]> {
  if (proxyUrl && !isValidProxyUrl(proxyUrl)) throw new Error("invalid-proxy");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INSTANCES_FETCH_TIMEOUT_MS);
  try {
    const init: Record<string, unknown> = {
      headers: { accept: "application/json", "user-agent": "dsh-web-searxng/refresh-instances" },
      redirect: "error",
      signal: ctrl.signal,
    };
    const res = (await (proxyUrl
      ? undiciFetch(source, { ...init, dispatcher: getOrCreateDispatcher(proxyUrl) as never })
      : fetch(source, init as RequestInit))) as unknown as Response;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    const root = asRecord(data);
    const table = (root ? asRecord(root.instances) : undefined) ?? (root && !Array.isArray(data) ? root : undefined);
    if (!table) throw new Error("unrecognized schema");
    const out: CuratedInstance[] = [];
    for (const [rawUrl, rawInfo] of Object.entries(table)) {
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (!url.startsWith("https://")) continue;
      const info = asRecord(rawInfo) ?? {};
      const status = statusFromStats2(info);
      if (status === "down") continue;
      const rawVersion = firstPresent(info, ["version", "searxng_version"]);
      out.push({
        url,
        status,
        uptimePct: healthFromStats2(info),
        latencyMs: latencyFromStats2(info),
        version: typeof rawVersion === "string" ? rawVersion : null,
      });
    }
    out.sort((a, b) => {
      if (a.status !== b.status) return a.status === "up" ? -1 : 1;
      if ((b.uptimePct ?? -1) !== (a.uptimePct ?? -1)) return (b.uptimePct ?? -1) - (a.uptimePct ?? -1);
      return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
    });
    return out.slice(0, Math.max(1, keep));
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw new Error("timeout");
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one refresh round and write the result back (never throws). The guard
 * in index.ts matches `refreshResultId` against the answered id, so this
 * write-back never re-triggers the round.
 */
export async function runRefreshRound(
  ctx: Context,
  snapshot: { refreshRequestId: string; instancesProxyUrl: string },
  writeBack: (patch: object) => Promise<unknown>,
): Promise<void> {
  try {
    const list = await fetchCuratedInstances(snapshot.instancesProxyUrl);
    await writeBack({
      refreshResultId: snapshot.refreshRequestId,
      instancesJson: JSON.stringify(list),
      instancesFetchedAt: new Date().toISOString(),
      refreshError: "",
    });
    ctx.logger.info(`[searxng] instances refreshed: ${list.length} rows`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.logger.warn(`[searxng] instances refresh failed: ${message}`);
    await writeBack({
      refreshResultId: snapshot.refreshRequestId,
      refreshError: message.length > 200 ? `${message.slice(0, 200)}…` : message,
    });
  }
}
