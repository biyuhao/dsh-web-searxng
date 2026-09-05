# dsh-web-searxng

Self-hosted [SearXNG](https://docs.searxng.org/) as the `web_search` backend for DSH.
给 DSH 接上自建 SearXNG 做 `web_search` 搜索后端（provider id: `searxng`）——不用把查询交给第三方搜索 API。

- 🖥️ **设置页配置卡**：实例地址 / BasicAuth / 分类 / 语言 / 安全搜索 / 出境代理（http/https/socks5(h)，可开关），保存实时生效、无需重启
- 🔌 **一键测试连接**：真搜一次，返回可用性 / 延迟 / 结果条数；失败是正常结果，直接显示原因（403 未开 JSON、429 限流、超时……）
- 📋 **社区实例选择器**：没自建也能用，searx.space 百级候选池，打开自动测速、可用的先列出来（满 10 个就停）；临时故障（限流/超时）排在长期不可用（JSON 未开）前面
- 🔄 **一键刷新名单**：走当前代理重拉 searx.space 并缓存，不用跑脚本
- 🇨🇳🇺🇸 中英双语卡片；1G 内存 VPS 可跑自建实例（见 `deploy/`）

要求 Node >= 20，DSH web profile。

## 安装

```bash
dsh plugin --profile web add dsh-web-searxng
```

本地验证当前代码：

```bash
dsh plugin --profile web add file:/path/to/dsh-web-searxng
```

装完重启 `dsh web`。

## 设为默认搜索（pin）

多搜索后端并存时，把默认指到 `searxng`，否则会报 `WEB_PROVIDER_AMBIGUOUS`。可靠做法是改 profile 用户层 `~/.dsh/profiles/web/cordis.patch.yml`（patch 整段替换 `config`，两个 key 都要写）：

```yaml
- id: web
  config:
    searchProvider: searxng
    fetchProvider: http
```

改完 `dsh --profile web --dump-config` 确认，再重启。只想试一次：`dsh --profile web --patch ./pin-searxng.patch.yml`（内容同上）。环境变量 `DSH_WEB_SEARCH_PROVIDER=searxng` 只在 composition 没写 pin 时生效，官方 base 默认写了 `deepseek-official`，单用它会被盖掉——本插件也不会自带 pin（全局默认是运维侧的选择，插件抢 pin 会打架）。

验证：

```
web_search({queries: ["searxng format=json"]})
```

## 配置

设置页 **SearXNG 搜索** 卡全部可配，也支持环境变量回退（`SEARXNG_BASE_URL` / `SEARXNG_USERNAME` / `SEARXNG_PASSWORD` / `SEARXNG_PROXY_URL`，见 `.env.example`）。优先级：**设置页 > composition entry > 环境变量**。

| 字段 | 说明 | 默认 |
|---|---|---|
| `baseURL` | SearXNG 实例地址，留空 = 未配置（provider 不可用） | `""` |
| `username` / `password` | BasicAuth，公用实例留空即不发 `Authorization` 头 | `""` |
| `categories` / `language` | SearXNG 搜索参数 | `general` / `zh-CN` |
| `safesearch` | `0` 关闭 / `1` 中等 / `2` 严格 | `1` |
| `proxyUrl` | 出境代理，留空 = 直连；出境受限的机器必填 | `""` |
| `proxyEnabled` | 代理启用开关（设置页勾选框）；关闭后走直连，地址保留 | `true` |

## 自建实例（`deploy/`）

```
deploy/
├── docker-compose.yml   # core（单 worker）+ valkey + Caddy，1G 内存可跑
├── Caddyfile            # HTTPS + BasicAuth + 只放行 /search
├── .env.example         # secret 模板
└── core-config/
    └── settings.yml     # formats 必开 json；引擎精简到抗封组合
```

```bash
cp deploy/.env.example ~/searxng/.env   # 填入真实 secret
# up 起容器后：
curl -su dsh:你的密码 'https://search.example.com/search?q=searxng&format=json' | head -c 2000
```

## 本地开发

```bash
pnpm install
pnpm run typecheck
pnpm run build     # host（tsc）+ client（tsc 声明 + esbuild bundle）
make help          # sync / smoke / probe / update-instances
make sync          # 构建后用本地 file: 覆盖到 dsh web profile 验证
```

实现要点：

- `src/host/provider.ts` — `GET /search?format=json` 薄适配，只返回真实来源，不编造成式内容
- `src/host/probe.ts` / `instances.ts` — 测试连接与名单刷新走 settings section 请求/响应往返（故意不用 host↔client RPC：第三方 client 上下文调不通 `ctx.remote.<ns>`）
- `src/host/dispatcher.ts` — 出境代理（undici `ProxyAgent` + socks bespoke Dispatcher）
- `src/client/` — 配置卡 + 选择器（中英 locale；可用优先、失败分层、待测态、100 候选早停）

## 安全说明

- 密码存于本地 settings 文档明文（与 env 同等敏感度），v1 不做 credentials-service 迁移。
- 社区实例可见查询明文，不要搜敏感内容；自建用 Caddy BasicAuth + 只放行 `/search`。
- 不要加 `google` 引擎（VPS IP 易触发 CAPTCHA）；搜出来慢先 `curl` 直测 VPS 本机 vs 经 Caddy 定位。

## 文档

- `docs/00-solution-full.md` — 全套方案（VPS 内存账本 / compose / 接线 / 排错）
- `docs/01-background.md` — DSH 分层与 SearXNG API 调研
- `docs/02-TODO.md` — 后续清单

## License

MIT — 见 `LICENSE`。
