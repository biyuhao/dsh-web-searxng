# dsh-web-searxng

Self-hosted [SearXNG](https://docs.searxng.org/) as the `web_search` backend for DSH.
用自建 SearXNG 给 DSH 提供 `web_search` 搜索后端（注册到 `ctx.web`，provider id: `searxng`）。

- 1G 内存 VPS 可跑（单 worker + 精简引擎 + Caddy，见 `deploy/`）
- Web 设置页有 **SearXNG 搜索** 配置卡：实例地址 / BasicAuth / 分类 / 语言 / 安全搜索 / 出境代理，保存后实时生效、无需重启
- 无自建实例时可从 searx.space 快照挑社区实例（选后务必 `make smoke` 自测；社区实例可见查询明文，敏感内容请自建）
- 实例地址旁有**测试连接**按钮（经宿主实测连通性：可用性 / 延迟 / 结果条数）；社区选择器打开后自动测速、可用实例优先排序
- 要求 Node >= 20，DSH web profile

## 安装

```bash
# 方式一：从 npm（发布后）
dsh plugin --profile web add dsh-web-searxng

# 方式二：本地目录（开发/验证当前代码）
dsh plugin --profile web add file:/path/to/dsh-web-searxng
```

装完重启 `dsh web`。多搜索后端并存时把 `searchProvider` pin 到 `searxng`（见下），否则会报 `WEB_PROVIDER_AMBIGUOUS`。省事可用仓库自带的启动脚本（已含 pin）：`ln -sf $PWD/scripts/launch-web.sh ~/.local/bin/dsh-web`，以后用 `dsh-web` 启动。

## 配置

两层配置，优先级：**设置页（`searxng` namespace）> cordis composition entry > 环境变量**。卡片写入 settings 文档，`cordis.patch.yml` + `SEARXNG_*` 环境变量是底层回退。

| 字段 | 说明 | 默认 |
|---|---|---|
| `baseURL` | SearXNG 实例地址，留空 = 未配置（provider 不可用） | `""` |
| `username` / `password` | Caddy BasicAuth，公用实例留空即不发 `Authorization` 头 | `""` |
| `categories` | SearXNG `categories` 参数 | `general` |
| `language` | SearXNG `language` 参数 | `zh-CN` |
| `safesearch` | `0` 关闭 / `1` 中等 / `2` 严格 | `1` |
| `proxyUrl` | 出境代理（`http/https/socks5(h)`），留空 = 直连；出境受限的机器必填 | `""` |

环境变量方式（或写本目录 `.env`，会被 `Makefile` 自动加载；不要提交真实密码）：

```bash
export SEARXNG_BASE_URL="https://search.example.com"
export SEARXNG_USERNAME="dsh"
export SEARXNG_PASSWORD="..."
# 可选：出境代理 / 指定 provider
export SEARXNG_PROXY_URL="socks5h://127.0.0.1:1080"
export DSH_WEB_SEARCH_PROVIDER="searxng"   # 与 dsh-web 的 searchProvider 等价，二选一
```

模型内验证（先 pin 默认 provider，避免多 provider 歧义 —— pin 是 web 缝启动配置，不是调用参数）：

```bash
DSH_WEB_SEARCH_PROVIDER=searxng dsh web
```

```
web_search({queries: ["searxng format=json"]})
```

语义（见 `@deepseek-ai/dsh-web` `WebRuntime`）：pin 且可用 → 必走它；未 pin 且多个可用 → `WEB_PROVIDER_AMBIGUOUS`；未 pin 且只剩 deepseek 可用 → 会去调 deepseek 并报缺 key（此时应检查本实例是否可用，而不是去配 deepseek 的 key）。卡片顶部也有这行指引。

注意：`DSH_WEB_SEARCH_PROVIDER` 只在 composition 没设 `searchProvider` 时生效。DSH base 层默认 pin 了 `deepseek-official`，会盖掉环境变量——可靠做法是改 profile 用户层（`~/.dsh/profiles/web/cordis.patch.yml`，patch 整段替换 `config`，两个 key 都要重写）：

```yaml
- id: web
  config:
    searchProvider: searxng
    fetchProvider: http
```

改完 `dsh --profile web --dump-config` 确认 `web.searchProvider` 已变成 `searxng`，再重启。用 `scripts/launch-web.sh`（或 `~/.local/bin/dsh-web`）启动可顺手带上环境变量，两者不冲突（patch 优先）。

不想动 profile 文件时，可用单次 overlay 试效果（作用相同， layer 顺序排最后；同样要重写两个 key）：

```bash
dsh --profile web --patch ./pin-searxng.patch.yml
```

```yaml
# pin-searxng.patch.yml（试完想持久化就把这段并入 profile 的 cordis.patch.yml）
- id: web
  config:
    searchProvider: searxng
    fetchProvider: http
```

社区用户三选一即可：profile patch（持久，推荐）/ `--patch`（免修改试用）/ 环境变量（仅 composition 未设 pin 时有效，官方 base 默认写了 deepseek，注意会被盖掉）。本插件不会自带 pin —— 全局默认是运维侧单点选择，插件抢 pin 会跟其他 provider 打架。

接线示例见 `docs/00-solution-full.md` 第 3.3 节。

## 自建实例（`deploy/`）

```
deploy/
├── docker-compose.yml   # core（Granian 1 worker）+ valkey（64MB）+ Caddy
├── Caddyfile            # HTTPS + BasicAuth + 只放行 /search
├── .env.example         # SEARXNG_SECRET_KEY 模板（openssl rand -hex 32）
└── core-config/
    └── settings.yml     # formats 必开 json；引擎精简到 7 个抗封组合
```

```bash
cp deploy/.env.example ~/searxng/.env   # 填入真实 secret
# 按 docs/00-solution-full.md 第 2 节 up 起容器后：
curl -su dsh:你的密码 'https://search.example.com/search?q=searxng&format=json' | head -c 2000
```

## 社区实例 + 联调

```bash
make probe   # curl 直测 ?format=json（需 SEARXNG_BASE_URL）
make smoke   # 直调 provider.search()（QUERY="..." 可换词，SEARXNG_PROXY_URL 可选）
make update-instances  # 拉 searx.space 刷新卡片快照（需直连外网）
```

注意：卡片里的连接测试已是一次真实带 JSON 的搜索，标 ● 的行等于自动 smoke 过，不必再手动 `make smoke`（`make smoke` 留给仓库开发联调）。

## 本地开发

```bash
pnpm install
pnpm run typecheck
pnpm run build     # host（tsc）+ client（tsc 声明 + esbuild bundle）
make help          # 常用操作：sync / smoke / probe / update-instances
make sync          # 构建后用本地 file: 覆盖到 dsh web profile（验证当前代码）
```

目录：

- `src/host/provider.ts` — SearXNG 薄适配器（`GET /search?format=json` → `WebSearchSource[]`，不编造成式 `content`）
- `src/host/index.ts` — Cordis 注册（inject `web` + settings `searxng` section + env 回退，配置热更新无需重启）
- `src/host/config.ts` — settings schema 与跨字段校验（host/client 共用同一规则）
- `src/host/dispatcher.ts` — 出境代理（undici `ProxyAgent` + socks bespoke Dispatcher）
- `src/host/probe.ts` — 连接测试（`searxng-probe` settings section 请求/响应往返：一次真实搜索，返回可用性/延迟/条数；失败是正常结果，不抛错；故意不用 host↔client RPC，第三方 client 上下文调不通 `ctx.remote.<ns>`）
- `src/client/` — 配置卡（`SearxngCard` + controller + 中英 locale + 社区实例快照；测试按钮与自动测速经 `searxng-probe` section 与宿主往返）
- `scripts/build-client.mjs` — client 打包（loader lazy-CJS artifact，serve 于 `/plugins/<pkg>/client.js`）
- `cordis.patch.yml` — bundle 接入声明（只有 host 行；浏览器 half 由 `package.json#dsh.client` 自动发现，不要加 loader 行）

## 安全说明

- 密码存于本地 settings 文档明文（与 env / `cordis.patch.yml` 同等敏感度），v1 不做 credentials-service 迁移（见 `src/host/config.ts` 注释）。
- 社区实例可见查询明文，不要搜敏感内容；自建实例用 Caddy BasicAuth + 只放行 `/search`，`formats` 只开 `json+html`。
- 搜出来慢先 `curl` 直测 VPS 本机 vs 经 Caddy，定位是引擎慢还是网络慢；不要加 `google` 引擎（VPS IP 易触发 CAPTCHA），详见 `docs/00-solution-full.md` 第 4 节。

## 文档

- `docs/00-solution-full.md` — 全套方案（VPS 内存账本 / compose / 插件代码 / 接线 / 排错清单）
- `docs/01-background.md` — DSH 分层与 SearXNG API 调研记录
- `docs/02-TODO.md` — 后续清单（fallback provider、调优项）

## License

MIT — 见 `LICENSE`。
