import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import {
  getOrCreateDispatcher,
  isValidProxyUrl,
  socksDependencyAvailable,
} from "./dispatcher.js";
import { fetch as undiciFetch } from "undici";

export interface SearxngOptions {
  baseURL: string;
  username?: string;
  password?: string;
  categories?: string;
  language?: string;
  safesearch?: number;
  /** 出境代理（http/https/socks5/socks5h），"" = 直连。GFW 后机器必配。 */
  proxyUrl?: string;
}

interface SearxngResultJson {
  url: string;
  title?: string;
  content?: string;
  engine?: string;
}

interface SearxngJson {
  query?: string;
  number_of_results?: number;
  results?: SearxngResultJson[];
}

function isUsableUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isSocksScheme(v: string): boolean {
  try {
    const p = new URL(v).protocol;
    return p === "socks:" || p === "socks5:" || p === "socks5h:";
  } catch {
    return false;
  }
}

/**
 * SearXNG-backed WebSearchProvider.
 * 对标 dsh-web-search-exa 的薄适配器写法：
 * - GET {baseURL}/search?q=&format=json （formats 必须在 settings.yml 开 json，否则 403）
 * - BasicAuth 走 Caddy 层鉴权
 * - SearXNG 不产生成式 answer，所以 content 省略，不编造
 */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = "searxng";
  constructor(private readonly opts: SearxngOptions) {}

  /** 纯本地检查，不做网络 IO（与官方 provider 一致，保持 selection 快速确定） */
  available(): boolean {
    if ((this.opts.baseURL?.length ?? 0) === 0 || !URL.canParse(this.opts.baseURL)) return false;
    if (this.opts.safesearch !== undefined && ![0, 1, 2].includes(this.opts.safesearch)) return false;
    if (this.opts.proxyUrl !== undefined && !isValidProxyUrl(this.opts.proxyUrl)) return false;
    // socks 依赖缺失时提前不可用（host 日志给安装指引，而非首搜才炸）。
    if (this.opts.proxyUrl && isSocksScheme(this.opts.proxyUrl) && !socksDependencyAvailable()) return false;
    return true;
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // 字符串拼接而非 new URL("/search", baseURL)：后者会丢弃 baseURL 自带的子路径
    // （如 https://host/searxng/）。SearXNG 没有 page-size 参数，maxResults 由 dsh-web
    // 的 seam 在返回路径上裁剪，这里只透传查询。
    let url: URL;
    try {
      url = new URL(`${this.opts.baseURL.replace(/\/+$/, "")}/search`);
    } catch (e) {
      throw new WebError(`SearXNG invalid baseURL: ${String(e)}`, "WEB_PROVIDER_ERROR", { cause: e });
    }
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", this.opts.language ?? "zh-CN");
    url.searchParams.set("pageno", "1");
    if (this.opts.categories) url.searchParams.set("categories", this.opts.categories);
    if (this.opts.safesearch !== undefined) url.searchParams.set("safesearch", String(this.opts.safesearch));

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "dsh-searxng/0.1.0",
    };
    if (this.opts.username) {
      headers["authorization"] =
        "Basic " + Buffer.from(`${this.opts.username}:${this.opts.password ?? ""}`).toString("base64");
    }

    let res: Response;
    try {
      if (this.opts.proxyUrl) {
        // 代理走 undici 自家 fetch + 同版本 Dispatcher：全局 fetch（Node 26 内核
        // undici 7）不认 undici 6 的 Dispatcher（"invalid onError method"）。
        res = (await undiciFetch(url, {
          headers,
          redirect: "error",
          ...(signal ? { signal } : {}),
          dispatcher: getOrCreateDispatcher(this.opts.proxyUrl) as never,
        })) as unknown as Response;
      } else {
        res = await fetch(url, { headers, redirect: "error", ...(signal ? { signal } : {}) });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: e });
      }
      throw new WebError(`SearXNG request failed: ${String(e)}`, "WEB_PROVIDER_ERROR", { cause: e });
    }
    if (!res.ok) {
      throw new WebError(`SearXNG HTTP ${res.status}`, "WEB_PROVIDER_ERROR");
    }
    let body: SearxngJson;
    try {
      body = (await res.json()) as SearxngJson;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: e });
      }
      throw new WebError(`SearXNG bad JSON: ${String(e)}`, "WEB_PROVIDER_ERROR", { cause: e });
    }

    const sources: WebSearchSource[] = (body.results ?? [])
      .map((r) => ({
        url: r.url,
        ...(r.title?.trim() ? { title: r.title.trim().slice(0, 300) } : {}),
        ...(r.content?.trim() ? { snippet: r.content.trim().slice(0, 500) } : {}),
      }))
      .filter((s) => isUsableUrl(s.url));

    return { sources, truncated: false };
  }
}
