// 联调冒烟脚本：直调 provider.search()，不经过 DSH。
// 用法：SEARXNG_BASE_URL=https://opnxng.com node scripts/smoke.mjs "hello"
// （opnxng 为第三方免费实例：无需用户名/密码；自建实例则再 export SEARXNG_USERNAME/PASSWORD）
// 出境受限机器：SEARXNG_PROXY_URL=socks5h://127.0.0.1:1080 （或 http://...）走代理。
import { SearxngSearchProvider } from "../lib/host/provider.js";

const baseURL = process.env.SEARXNG_BASE_URL;
if (!baseURL) {
  console.error("请先 export SEARXNG_BASE_URL=https://opnxng.com （或你的自建地址）");
  process.exit(1);
}

const provider = new SearxngSearchProvider({
  baseURL,
  username: process.env.SEARXNG_USERNAME || undefined,
  password: process.env.SEARXNG_PASSWORD || undefined,
  categories: "general",
  language: "zh-CN",
  safesearch: 1,
  proxyUrl: process.env.SEARXNG_PROXY_URL || undefined,
});

console.log("available():", provider.available());
const query = process.argv[2] ?? "searxng format=json";
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 25000);
try {
  const t0 = Date.now();
  const ret = await provider.search({ query, maxResults: 8 }, ctrl.signal);
  console.log(`query=${JSON.stringify(query)} elapsed=${Date.now() - t0}ms sources=${ret.sources.length}`);
  for (const s of ret.sources.slice(0, 5)) {
    console.log("-", s.title ?? "(no title)", "\n  ", s.url, "\n  ", (s.snippet ?? "").slice(0, 120));
  }
} finally {
  clearTimeout(t);
}
