/**
 * Settings schema for dsh-web-searxng (Host).
 *
 * Namespace: `searxng` (same key the client card registers under).
 * Single source of truth for validation — used by Host registration
 * and mirrored in Client for fast local feedback.
 *
 * Layering: the cordis composition entry (cordis.patch.yml + env fallback)
 * is the base; the settings scope overrides it field-by-field once attached.
 * Password rides the settings document in plaintext (same sensitivity as
 * cordis.patch.yml / env today); a credentials-service migration is
 * explicitly out of scope for v1.
 */

import z from "@deepseek-ai/schemastery";
import { isValidProxyUrl } from "./dispatcher.js";

export const SearxngSettingsSchema: any = z.object({
  /** Instance base URL. "" = not configured → provider unavailable. */
  baseURL: z.string(),
  /** Caddy BasicAuth username. "" = no auth (public instances). */
  username: z.string(),
  /** Caddy BasicAuth password. "" = none. */
  password: z.string(),
  /** SearXNG categories parameter. */
  categories: z.string(),
  /** SearXNG language parameter. */
  language: z.string(),
  /** SearXNG safesearch parameter (0/1/2). */
  safesearch: z.number().step(1).min(0).max(2),
  /** Egress proxy (http/https/socks5/socks5h). "" = direct. */
  proxyUrl: z.string(),
  /** false = keep proxyUrl but go direct. Missing (pre-switch docs) = enabled. */
  proxyEnabled: z.boolean(),
});

export interface SearxngSettings {
  baseURL: string;
  username: string;
  password: string;
  categories: string;
  language: string;
  safesearch: number;
  proxyUrl: string;
  proxyEnabled: boolean;
}

export const SearxngSettings: any = SearxngSettingsSchema;

/** Defaults for fields the entry layer leaves empty. */
export const SEARXNG_DEFAULT_CATEGORIES = "general";
export const SEARXNG_DEFAULT_LANGUAGE = "zh-CN";
export const SEARXNG_DEFAULT_SAFESEARCH = 1;

/**
 * Cross-field validation the schema alone cannot express.
 * Empty baseURL is a legitimate "not configured" state (provider simply
 * reports unavailable); a non-empty one must parse as an absolute URL.
 */
export function assertServiceable(config: SearxngSettings): void {
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
