/**
 * Settings schema for dsh-web-searxng (Host), exported as `Config`: the
 * Loader entry's Cordis Config whose volatile fields the settings UI projects
 * as the `searxng` section (the entry id). Single source of truth for
 * validation — Host reads use it; the Client mirrors the shapes for fast
 * local feedback. The composition entry (cordis.patch.yml + env fallback,
 * resolved in index.ts) is the base layer; password rides the config in
 * plaintext (credentials-service migration is out of scope for v1).
 */

import z from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cordis";
import { isValidProxyUrl } from "./dispatcher.js";

/** Defaults for fields the entry layer leaves empty. */
export const SEARXNG_DEFAULT_CATEGORIES = "general";
export const SEARXNG_DEFAULT_LANGUAGE = "zh-CN";
export const SEARXNG_DEFAULT_SAFESEARCH = 1;
/** Default per-target probe timeout; host clamps incoming rounds to 3–30s. */
export const PROBE_DEFAULT_TIMEOUT_MS = 12_000;

export const SearxngSettingsSchema: any = z.object({
  /** Instance base URL. "" = not configured → provider unavailable. */
  baseURL: z.string().default('').volatile(),
  /** Caddy BasicAuth username. "" = no auth (public instances). */
  username: z.string().default('').volatile(),
  /** Caddy BasicAuth password. "" = none. */
  password: z.string().default('').volatile(),
  /** SearXNG categories parameter. */
  categories: z.string().default(SEARXNG_DEFAULT_CATEGORIES).volatile(),
  /** SearXNG language parameter. */
  language: z.string().default(SEARXNG_DEFAULT_LANGUAGE).volatile(),
  /** SearXNG safesearch parameter (0/1/2). */
  safesearch: z.number().step(1).min(0).max(2).default(SEARXNG_DEFAULT_SAFESEARCH).volatile(),
  /** Egress proxy (http/https/socks5/socks5h). "" = direct. */
  proxyUrl: z.string().default('').volatile(),
  /** false = keep proxyUrl but go direct. */
  proxyEnabled: z.boolean().default(true).volatile(),
  // ── probe/refresh round-trip (card ↔ host, request/response over these
  // fields). All hidden(true): protocol wiring, not user-facing settings. ──
  /** Fresh id per round, written LAST by the card. "" = idle. */
  probeRequestId: z.string().default('').volatile().hidden(true),
  /** JSON array of ProbeTarget. Cap enforced host-side. */
  probeTargetsJson: z.string().default('[]').volatile().hidden(true),
  /** Egress proxy shared by the round. "" = direct. */
  probeProxyUrl: z.string().default('').volatile().hidden(true),
  /** Per-target timeout ms, clamped host-side to 3–30s. */
  probeTimeoutMs: z.number().default(PROBE_DEFAULT_TIMEOUT_MS).volatile().hidden(true),
  /** probeRequestId this result answers. "" = none yet. */
  probeResultId: z.string().default('').volatile().hidden(true),
  /** JSON array of ProbeTargetResult. */
  probeResultsJson: z.string().default('[]').volatile().hidden(true),
  /** Round-level failure (e.g. malformed request). "" = none. */
  probeError: z.string().default('').volatile().hidden(true),
  // ── community-list refresh round-trip + runtime cache ──
  /** JSON array of curated instances (the runtime cache). "[]" = none. */
  instancesJson: z.string().default('[]').volatile().hidden(true),
  /** ISO time the cache was fetched. "" = never. */
  instancesFetchedAt: z.string().default('').volatile().hidden(true),
  /** Egress proxy for the searx.space fetch. "" = direct. */
  instancesProxyUrl: z.string().default('').volatile().hidden(true),
  /** Fresh id per refresh, written LAST by the card. "" = idle. */
  refreshRequestId: z.string().default('').volatile().hidden(true),
  /** refreshRequestId this result answers. "" = none yet. */
  refreshResultId: z.string().default('').volatile().hidden(true),
  /** Refresh-level failure (fetch/parse). "" = none. Cache untouched. */
  refreshError: z.string().default('').volatile().hidden(true),
});

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

/** User-facing fields (what the settings card edits). */
export interface SearxngBase {
  baseURL: string;
  username: string;
  password: string;
  categories: string;
  language: string;
  safesearch: number;
  proxyUrl: string;
  proxyEnabled: boolean;
}

/** Probe/refresh round-trip fields as stored in the entry config. */
export interface SearxngProtocol {
  probeRequestId: string;
  probeTargetsJson: string;
  probeProxyUrl: string;
  probeTimeoutMs: number;
  probeResultId: string;
  probeResultsJson: string;
  probeError: string;
  instancesJson: string;
  instancesFetchedAt: string;
  instancesProxyUrl: string;
  refreshRequestId: string;
  refreshResultId: string;
  refreshError: string;
}

export interface SearxngSettings extends SearxngBase, SearxngProtocol {}

/** Loader-facing alias. */
export const Config: any = SearxngSettingsSchema;

/** `apply` receives one stable volatile reference per Config field. */
export interface SearxngConfigRef extends SearxngProtocolRefs {
  baseURL: Volatile<string>;
  username: Volatile<string>;
  password: Volatile<string>;
  categories: Volatile<string>;
  language: Volatile<string>;
  safesearch: Volatile<number>;
  proxyUrl: Volatile<string>;
  proxyEnabled: Volatile<boolean>;
}

/** Volatile references for the probe/refresh round-trip fields. */
export type SearxngProtocolRefs = {
  [K in keyof SearxngProtocol]: Volatile<SearxngProtocol[K]>;
};

/**
 * Cross-field validation the schema cannot express: empty baseURL is a
 * legitimate "not configured" state; a non-empty one must parse as an
 * absolute URL.
 */
export function assertServiceable(config: SearxngBase): void {
  if (config.baseURL !== "" && !URL.canParse(config.baseURL)) {
    throw new Error(`searxng: baseURL is not a valid URL: ${JSON.stringify(config.baseURL.slice(0, 80))}`);
  }
  if (![0, 1, 2].includes(config.safesearch)) {
    throw new Error(`searxng: safesearch must be 0, 1 or 2, got ${JSON.stringify(config.safesearch)}`);
  }
  // Disabled proxy rides along as inert data (still stored, never dialed),
  // so only validate its scheme while enabled.
  if ((config.proxyEnabled ?? true) && !isValidProxyUrl(config.proxyUrl ?? "")) {
    throw new Error(`searxng: proxyUrl scheme unsupported (http/https/socks5/socks5h): ${JSON.stringify((config.proxyUrl ?? "").slice(0, 80))}`);
  }
}

/** Effective egress proxy: "" = direct (disabled proxies are kept, not dialed). */
export function effectiveProxyUrl(config: { proxyUrl?: string; proxyEnabled?: boolean }): string {
  if (config.proxyEnabled === false) return "";
  return config.proxyUrl ?? "";
}

/** baseURL with password redacted for host logs. */
export function redactBaseURL(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return baseURL;
  }
}

/** proxyUrl with credentials redacted for host logs. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return proxyUrl;
  }
}
