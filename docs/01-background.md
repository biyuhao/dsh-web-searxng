# 背景与调研记录

## 用户目标
- 在 DSH 中支持 web search。
- 自有 1G 内存 VPS，部署 SearXNG 提供搜索，再为 DSH 提供搜索能力并接入。

## DSH 侧关键发现（实测本机得出）
- DSH 通过 `dsh web`（profile web）启动，插件由 `~/.dsh/profiles/web/package.json` 的
  `dsh.profile.bundles` + `cordis.patch.yml` 组成；全局 overlay 在 `~/.dsh/cordis.patch.yml`（当前为空数组）。
- 可参照的同构插件：`dsh-plugin-model-proxy`（同工作区内的姊妹仓），
  含 `package.json#dsh.bundle.patch` + `cordis.patch.yml` + `lib/host + lib/client` 双构建。
  安装方式：`dsh plugin --profile web add <pkg>`（透传给 pnpm）。
- Web 能力分层（`/opt/homebrew/lib/node_modules/@deepseek-ai/`）：
  - `@deepseek-ai/dsh-web`：`ctx.web` 服务，`registerSearchProvider/registerFetchProvider`，
    调用时按 `searchProvider/fetchProvider` pin 或“唯一可用者”自动选择；
    无可用 → `WEB_PROVIDER_UNAVAILABLE`，多可用未 pin → `WEB_PROVIDER_AMBIGUOUS`。
  - 官方搜索后端仅三家：`dsh-web-search-exa（id: exa）`、
    `dsh-web-search-perplexity（id: perplexity）`、`dsh-web-search-deepseek（id: deepseek-official）`，
    均无 SearXNG，故需自写 provider。
  - `dsh-tool-web`：模型可见 `web_search({queries[1..4]})/web_fetch({url})`，
    fan-out 并发 + round-robin 合并 + `searchMaxResults(默认8)` 截断 + untrusted 标注；
    超时由 `searchTimeoutMs/fetchTimeoutMs（默认 30000）` 经 timeout-policy 执行。
  - `dsh-web-fetch-http`：匿名公网抓取后端（id: http），`web_fetch` 继续沿用它。
- Exa provider 实现（`dsh-web-search-exa/lib/index.js`）是本插件的直接模板：
  `available()` 只做本地检查（key 非空 + URL 可解析），`search()` 用 `fetch(..., {redirect:'error'})`，
  Abort 判 `DOMException name === 'AbortError'` → `WEB_ABORTED`，其余 → `WEB_PROVIDER_ERROR`。

## SearXNG 侧关键事实（官方文档 docs.searxng.org）
- 推荐部署：`searxng/searxng:latest`（DockerHub/GHCR 双源）+ compose（含 valkey）；
  配置挂载 `/etc/searxng`（settings.yml），数据 `/var/cache/searxng`；后端已为 Granian（`$GRANIAN_*` 调参）。
- 搜索 API：`GET/POST / 或 /search`，`GET` 用 querystring，`POST` 用 form；
  `?q=..&format=json`，`format` 必须在 `settings.yml#search.formats` 里显式开启，否则 403；
  另支持 `categories/language/pageno/time_range/safesearch`。
- JSON 返回：`{query, number_of_results, results: [{url, title, content, engine, ...}], answers, ...}`，
  `content` 即 snippet 来源；一般无可靠 `publishedDate`。
- 运维注意：VPS IP 直连 Google 极易触发 CAPTCHA（官方有 answer-captcha 篇）；公共实例多关 json，需自建。

## 决策
- VPS：单 core + valkey(64mb) + Caddy，Granian 1 worker，引擎精简 7 个，BasicAuth 放 Caddy。
- DSH：自写 `dsh-web-searxng（provider id: searxng）`，`searchProvider: searxng` pin 住。
- 零代码 bash+curl 方案仅作连通性验证，不长期用（丢 prompt/引用/超时/UI 卡片）。

完整方案见 `docs/00-solution-full.md`。
