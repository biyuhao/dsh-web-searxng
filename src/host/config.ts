/** SearXNG settings schema and protocol types. */

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
  /** Instance base URL. */
  baseURL: z.string().default('').volatile(),
  /** BasicAuth username. */
  username: z.string().default('').volatile(),
  /** BasicAuth password. */
  password: z.string().default('').volatile(),
  /** SearXNG categories. */
  categories: z.string().default(SEARXNG_DEFAULT_CATEGORIES).volatile(),
  /** SearXNG language. */
  language: z.string().default(SEARXNG_DEFAULT_LANGUAGE).volatile(),
  /** SearXNG safesearch. */
  safesearch: z.number().step(1).min(0).max(2).default(SEARXNG_DEFAULT_SAFESEARCH).volatile(),
  /** Egress proxy. */
  proxyUrl: z.string().default('').volatile(),
  /** false = keep proxyUrl but go direct. */
  proxyEnabled: z.boolean().default(true).volatile(),
  // ── Probe/refresh protocol fields ──
  /** Round ID, written last. */
  probeRequestId: z.string().default('').volatile().hidden(true),
  /** Probe target JSON. */
  probeTargetsJson: z.string().default('[]').volatile().hidden(true),
  /** Egress proxy shared by the round. "" = direct. */
  probeProxyUrl: z.string().default('').volatile().hidden(true),
  /** Probe timeout. */
  probeTimeoutMs: z.number().default(PROBE_DEFAULT_TIMEOUT_MS).volatile().hidden(true),
  /** Result ID. */
  probeResultId: z.string().default('').volatile().hidden(true),
  /** Probe result JSON. */
  probeResultsJson: z.string().default('[]').volatile().hidden(true),
  /** Round error. */
  probeError: z.string().default('').volatile().hidden(true),
  // ── Instance refresh/cache fields ──
  /** Instance cache JSON. */
  instancesJson: z.string().default('[]').volatile().hidden(true),
  /** Cache timestamp. */
  instancesFetchedAt: z.string().default('').volatile().hidden(true),
  /** Refresh proxy. */
  instancesProxyUrl: z.string().default('').volatile().hidden(true),
  /** Refresh ID, written last. */
  refreshRequestId: z.string().default('').volatile().hidden(true),
  /** Refresh result ID. */
  refreshResultId: z.string().default('').volatile().hidden(true),
  /** Refresh error. */
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
  /** Provider error. */
  error?: string;
}

/** User-facing settings. */
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

/** Protocol fields. */
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

/** Loader alias. */
export const Config: any = SearxngSettingsSchema;

/** Volatile config references. */
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

/** Protocol references. */
export type SearxngProtocolRefs = {
  [K in keyof SearxngProtocol]: Volatile<SearxngProtocol[K]>;
};

/** Validate a serviceable config. */
export function assertServiceable(config: SearxngBase): void {
  if (config.baseURL !== "" && !URL.canParse(config.baseURL)) {
    throw new Error(`searxng: baseURL is not a valid URL: ${JSON.stringify(config.baseURL.slice(0, 80))}`);
  }
  if (![0, 1, 2].includes(config.safesearch)) {
    throw new Error(`searxng: safesearch must be 0, 1 or 2, got ${JSON.stringify(config.safesearch)}`);
  }
  // Disabled proxies are kept but not dialed.
  if ((config.proxyEnabled ?? true) && !isValidProxyUrl(config.proxyUrl ?? "")) {
    throw new Error(`searxng: proxyUrl scheme unsupported (http/https/socks5/socks5h): ${JSON.stringify((config.proxyUrl ?? "").slice(0, 80))}`);
  }
}

/** Effective proxy URL. */
export function effectiveProxyUrl(config: { proxyUrl?: string; proxyEnabled?: boolean }): string {
  if (config.proxyEnabled === false) return "";
  return config.proxyUrl ?? "";
}

/** Redact baseURL credentials. */
export function redactBaseURL(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return baseURL;
  }
}

/** Redact proxy credentials. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return proxyUrl;
  }
}
