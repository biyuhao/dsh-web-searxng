/** Cached undici dispatchers for HTTP(S) and SOCKS proxies. */

import { ProxyAgent, Agent } from "undici";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import tls from "node:tls";

const cache = new Map<string, unknown>();

/** SOCKS default port. */
const DEFAULT_SOCKS_PORT = 1080;

export const PROXY_POOL_DEFAULTS = {
  keepAliveTimeout: 30_000,
  connections: 20,
};

export const PROXY_SCHEMES = new Set(["http:", "https:", "socks:", "socks5:", "socks5h:"]);

export function isValidProxyUrl(v: string): boolean {
  if (v === "") return true;
  try {
    return PROXY_SCHEMES.has(new URL(v).protocol);
  } catch {
    return false;
  }
}

function defaultPortFor(protocol: string): number {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return 443;
}

/** Lazy socks client loader. */
function loadSocksClient(): { createConnection(opts: unknown): Promise<{ socket: import("net").Socket }> } {
  try {
    const require = createRequire(import.meta.url);
    const mod: unknown = require("socks");
    if (mod === null || typeof mod !== "object") throw new Error("no exports");
    const SocksClient = (mod as { SocksClient?: unknown }).SocksClient as
      | { createConnection?: unknown }
      | undefined;
    if (typeof SocksClient?.createConnection !== "function") throw new Error("SocksClient.createConnection missing");
    return SocksClient as { createConnection(opts: unknown): Promise<{ socket: import("net").Socket }> };
  } catch (e) {
    // Deliberately no proxyUrl in this message: it may carry credentials.
    throw new Error(`socks proxy requires dependency "socks" (pnpm add socks). Original: ${String(e)}`);
  }
}

let socksProbe: boolean | undefined;

/** Memoized socks availability check. */
export function socksDependencyAvailable(): boolean {
  if (socksProbe === undefined) {
    try {
      loadSocksClient();
      socksProbe = true;
    } catch {
      socksProbe = false;
    }
  }
  return socksProbe;
}

/** Build a SOCKS dispatcher. */
function createSocksDispatcher(proxyUrl: string): unknown {
  const SocksClient = loadSocksClient();

  const u = new URL(proxyUrl);
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port) || DEFAULT_SOCKS_PORT;

  const connectThroughSocks: (
    opts: { hostname?: string; host?: string; protocol?: string; port?: string; servername?: string | null },
    callback: (err: Error | null, socket?: import("net").Socket) => void,
  ) => void = (opts, callback) => {
    const host = opts.hostname ?? opts.host ?? "";
    const port = opts.port ? Number(opts.port) : defaultPortFor(opts.protocol ?? "https:");
    if (!host) {
      callback(new Error("socks connect: missing destination host"));
      return;
    }

    const finishRaw = (raw: import("net").Socket) => {
      if (opts.protocol === "https:" || port === 443) {
        // Do not put an IP literal in SNI.
        const servername = opts.servername ?? host;
        const tlsOpts: import("tls").ConnectionOptions = { socket: raw, host, port };
        if (servername && !isIP(servername)) tlsOpts.servername = servername;
        const secure = tls.connect(tlsOpts);
        secure.once("secureConnect", () => callback(null, secure));
        secure.once("error", (err) => callback(err));
      } else {
        callback(null, raw);
      }
    };

    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5 },
      command: "connect",
      destination: { host, port },
    })
      .then((info) => finishRaw(info.socket))
      .catch((err: Error) => callback(err));
  };

  return new Agent({ ...PROXY_POOL_DEFAULTS, connect: connectThroughSocks as never });
}

/** Cached dispatcher per proxy URL. */
export function getOrCreateDispatcher(proxyUrl: string): unknown {
  const cached = cache.get(proxyUrl);
  if (cached) return cached;

  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    throw new Error(`invalid proxyUrl: ${JSON.stringify(proxyUrl.slice(0, 32))}…(truncated)`);
  }

  let d: unknown;
  if (u.protocol === "http:" || u.protocol === "https:") {
    d = new ProxyAgent({ uri: proxyUrl, ...PROXY_POOL_DEFAULTS });
  } else if (u.protocol === "socks5:" || u.protocol === "socks5h:" || u.protocol === "socks:") {
    d = createSocksDispatcher(proxyUrl);
  } else {
    throw new Error(`unsupported proxy protocol "${u.protocol}"`);
  }

  cache.set(proxyUrl, d);
  return d;
}

/** Clear cached dispatchers. */
export function clearDispatcherCache(proxyUrl?: string): number {
  const keys = proxyUrl !== undefined ? [proxyUrl] : [...cache.keys()];
  let removed = 0;
  for (const key of keys) {
    const d = cache.get(key);
    if (!cache.delete(key)) continue;
    removed++;
    const closer = (d as { close?: () => Promise<unknown> } | undefined)?.close;
    if (typeof closer === "function") {
      void closer.call(d).catch(() => {});
    }
  }
  return removed;
}
