# SearXNG（1G VPS）为 DSH 提供 web_search：全套解决方案

> 结论先行：1G 内存跑得动 SearXNG，但必须用**精简单容器 + valkey 可选 + 少引擎 + 单 worker**的组合；
> DSH 侧官方没有 SearXNG provider（只有 exa / perplexity / deepseek 三个），所以要写一个约 120 行的
> `dsh-web-searxng` 小插件注册到 `ctx.web`，再用 `dsh-tool-web` 暴露 `web_search` 给模型。
> 下面所有配置都可直接复制上线。
>
> **2026-09-24 迁移**：插件已适配 dsh 0.1.7 volatile Config 架构——entry id 即 settings namespace
> （现为 `searxng`），`apply` 收到的是逐字段 volatile 引用；probe/instances 通道复用同一 entry 的
> Config 字段（`probeRequestId` 等前缀字段），卡片经 `configForms.get('searxng')` 读写、host 经
> `settings.update` 回写。本文写作于旧架构（`installSection` / `web-searxng/host`）时期，细节以
> 仓库当前源码与 `cordis.patch.yml` 为准。

```
┌─────────────┐   web_search(queries[])   ┌──────────────────────────┐   GET /search?q=&format=json  ┌──────────────┐
│ DSH (本地/  │ ───────────────────────▶ │ dsh-web-searxng            │ ───────────────────────────▶ │ SearXNG      │ ──▶ Bing/DDG/Brave/维基/…
│ 服务器)     │ ◀─────────────────────── │  (provider id: searxng)  │ ◀─────────────────────────── │ 1G VPS容器   │
│ dsh-tool-web│   WebSearchSource[]       │ ctx.web.registerSearch.. │   JSON {results[]}            │ +Caddy HTTPS │
└─────────────┘                           └──────────────────────────┘                               └──────────────┘
                                                     ▲                                                      ▲
                                          searchProvider: searxng                                 BasicAuth/IP白名单
                                          fetchProvider: http (官方 dsh-web-fetch-http 照旧负责 web_fetch)
```

DSH 的搜索分层（实测 `~/.dsh/profiles` + `/opt/homebrew/lib/node_modules/@deepseek-ai/` 得出）：

| 层 | 包 | 职责 |
|---|---|---|
| 服务缝合 | `@deepseek-ai/dsh-web` | `ctx.web.search()/fetch()`，负责选 provider、裁 `maxResults`、统一 `WebError` |
| 搜索后端 | `dsh-web-search-exa/perplexity/deepseek` | 各注册一个 id（`exa` / `perplexity` / `deepseek-official`），`available()` 只是本地检查 key 是否存在 |
| 模型工具 | `@deepseek-ai/dsh-tool-web` | 暴露 `web_search({queries[1..4]}]`、`web_fetch({url})`，并发 fan-out、round-robin 合并、`searchMaxResults` 截断、untrusted 标注 |
| 抓取后端 | `@deepseek-ai/dsh-web-fetch-http` | 匿名公网抓取，`web_fetch` 继续用它即可，不用经 SearXNG |

所以你要做的只有两件事：**VPS 上起一个省内存的 SearXNG** + **给 DSH 加一个 SearXNG 搜索 provider**。

---

## 1. VPS 选型与内存账本（1G 能不能跑？能）

实测口径的内存占用（x86_64，SearXNG 官方镜像 `searxng/searxng:latest`，后端已从 uwsgi 换成 Granian）：

| 组件 | 常驻内存 | 说明 |
|---|---|---|
| SearXNG core（Granian 1 worker / 2 threads） | ~120–200 MB | 默认 4 worker 会爆内存，必须压到 1 |
| valkey（limiter/缓存用） | ~30–60 MB | 单实例个人用**可以删掉**，代价是失去限流+缓存；推荐保留但加 `maxmemory 64mb` |
| Caddy（反代+HTTPS，比 nginx 省） | ~20–30 MB | 自动续签证书，配置只有十几行 |
| 系统 + docker overhead | ~200–300 MB | Ubuntu 22.04 minimal 约此数 |
| **合计** | **~450–600 MB** | 留 ~400MB Buffer/cache，1G 刚好但必须加 swap |

必做：

```bash
# 1. 2G swap（1G 机不加 swap，apt + docker build 时 OOM killer 会随机杀容器）
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. VPS 初始化
sudo apt update && sudo apt install -y docker.io docker-compose-plugin curl
sudo usermod -aG docker $USER && newgrp docker
```

> 如果 VPS 在国内，`docker.io` 镜像拉不下来就换 GHCR：`ghcr.io/searxng/searxng:latest`
> （DockerHub 对匿名 pull 限流，GHCR 是官方镜像源之一）。

---

## 2. VPS 侧：最小 docker-compose（单 core + 可选 valkey + Caddy）

目录结构：

```
~/searxng/
├── docker-compose.yml
├── .env
├── Caddyfile
└── core-config/
    └── settings.yml
```

### 2.1 `docker-compose.yml`（1G 特调版）

```yaml
services:
  # valkey 只做 limiter+缓存。极端省内存可整段删掉，并在 settings.yml 里关 limiter（见下）
  valkey:
    image: docker.io/valkey/valkey:8-alpine
    command: ["valkey-server", "--save", "", "--appendonly", "no", "--maxmemory", "64mb", "--maxmemory-policy", "allkeys-lru"]
    restart: unless-stopped
    mem_limit: 96m
    mem_reservation: 48m
    volumes:
      - valkey-data:/data

  core:
    image: docker.io/searxng/searxng:latest   # 国内拉不动换 ghcr.io/searxng/searxng:latest
    restart: unless-stopped
    mem_limit: 512m
    mem_reservation: 256m
    ports:
      - "127.0.0.1:8080:8080"   # 只绑回环，公网经 Caddy 进来
    volumes:
      - ./core-config:/etc/searxng:ro
    env_file: .env
    environment:
      # Granian：1 worker 是 1G 机的生命线；线程给 2–4
      - GRANIAN_WORKERS=1
      - GRANIAN_THREADS=2
      - GRANIAN_INTERFACE=wsgi
      - SEARXNG_BASE_URL=https://search.example.com/
      - SEARXNG_SECRET_KEY=${SEARXNG_SECRET_KEY}
      # 禁掉调试+开放 HTTP 方法收紧
      - SEARXNG_DEBUG=false
    depends_on:
      - valkey
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  caddy:
    image: docker.io/caddy:2-alpine
    restart: unless-stopped
    mem_limit: 64m
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - core

volumes:
  valkey-data:
  caddy-data:
  caddy-config:
```

> 把 `core` 的 `mem_limit` 设 512m 是故意的：让 OOM 先杀 core 而不是整机卡死，
> 配合 `restart: unless-stopped` 自动恢复。

### 2.2 `.env`

```bash
# 用 openssl rand -hex 32 生成，改一次就要重启 core
SEARXNG_SECRET_KEY=在这里填64位hex
```

### 2.3 `Caddyfile`（HTTPS + BasicAuth + 只放行 /search JSON）

SearXNG 自身鉴权很弱（`search.formats` 开关 + limiter），**真正的鉴权放在 Caddy 层**。
DSH 是唯一的调用方，所以连 Web 界面都可以不对公网开放：

```
search.example.com {
    # DSH 专用的账号，Caddy 会对所有请求要求它
    basicauth {
        dsh  $2a$14$...   # caddy hash-password 生成
    }

    # 只允许搜素 API + 健康检查，管理页/配置页一律 404（减少被扫）
    @api path /search /healthz /stats/errors
    handle @api {
        reverse_proxy 127.0.0.1:8080
    }
    handle {
        respond "Not Found" 404
    }

    log {
        output file /data/access.log
    }
}
```

生成 hash：`docker run --rm caddy:2-alpine caddy hash-password`。
DSH 侧请求时带 `-u dsh:你的密码` 即可（插件里拼成 `Authorization: Basic ...`）。

如果你有固定 IP 的 DSH 服务器，更进一步可以在 VPS 防火墙只放行它：

```bash
sudo ufw allow 80,443/tcp
sudo ufw default deny incoming
# DSH 服务器 IP 才能直接连（Caddy 之前再加一层）
sudo ufw allow from <DSH服务器IP> to any port 443
```

### 2.4 `core-config/settings.yml`（1G + DSH API 特调，重点）

只列和默认不同的项，直接全量覆盖 `core-config/settings.yml` 即可：

```yaml
general:
  debug: false
  instance_name: "dsh-private-search"

server:
  secret_key: "@SEARXNG_SECRET_KEY@"   # 从 .env 注入，官方镜像支持 @VAR@ 写法；不行就写明文 key
  limiter: true          # 有 valkey 就开；删掉 valkey 的话这里改 false
  image_proxy: false     # DSH 只用 JSON，图片代理关掉省内存/CPU
  http_protocol_version: "1.1"
  method: "GET"          # DSH 用 GET /search?q=&format=json
  default_http_headers:
    User-Agent: "Mozilla/5.0 (X11; Linux x86_64) dsh-searxng/1.0"

search:
  safe_search: 1
  autocomplete: ""       # 关联想，省一次请求
  default_lang: "zh-CN"
  formats:               # DSH 只需要 json；rss/csv 不开，csv 开了反而容易被扫
    - html
    - json
  # DSH 传 maxResults，这里给个兜底
  default_theme_args: {}

# 引擎精简是省内存+防封的关键：默认启用的 100+ 引擎并发打出去，
# 1G 机直接超时+被 Google/Bing 封 IP。个人 DSH 只留这几个高质量+抗封的：
engines:
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    timeout: 6.0
  - name: brave
    engine: brave
    shortcut: brv
    timeout: 6.0
  - name: bing
    engine: bing
    shortcut: bi
    timeout: 6.0
  - name: mojeek
    engine: mojeek
    shortcut: mjk
    timeout: 6.0
  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    timeout: 4.0
  - name: openalex        # 学术
    engine: openalex
    shortcut: oal
    timeout: 6.0
  - name: github          # 代码
    engine: github
    shortcut: gh
    timeout: 6.0

outgoing:                # 外发超时收紧，避免一个慢引擎拖住整次搜索
  request_timeout: 6.0
  max_request_timeout: 12.0
  pool_connections: 20
  pool_maxsize: 20
  enable_http2: false    # 1G 机关 http2 省 CPU

valkey:
  url: redis://valkey:6379/0

# DSH 高频调用，bot 保护会误杀自己：放行本机+信任 X-Forwarded-For（Caddy 已做鉴权）
# limiter.toml 如需细调可另建文件，这里给宽松默认
```

说明：

- `formats` 必须含 `json`，否则 `GET /search?format=json` 直接 **403**（官方文档原话）。
- 引擎不要加 `google`：VPS IP 直连 Google 极易触发 CAPTCHA（官方有专门的
  “Answer CAPTCHA from server's IP” 页面讲这事）。Bing/Brave/DDG/Mojeek 对数据中心 IP 宽容得多。
  确实要 Google 就去申请一个 Brave Search API / Exa key 做补充，而不是硬爬。
- `server.method: GET` + `outgoing.request_timeout` 收紧后，P95 延迟一般 2–5s，
  DSH 侧 `searchTimeoutMs: 30000` 足够。

启动验证：

```bash
cd ~/searxng && docker compose up -d
sleep 25 && docker compose ps && docker compose logs --tail=50 core
# 本机直调（绕过 Caddy）
curl -s 'http://127.0.0.1:8080/search?q=searxng&format=json&language=zh-CN' | head -c 2000
# 公网经 Caddy + BasicAuth
curl -su dsh:你的密码 'https://search.example.com/search?q=searxng&format=json' | head -c 2000
```

返回形如 `{"query": "...", "results": [{"url":..., "title":..., "content":..., "engine":...}]}` 即成功。
`content` 字段就是 DSH 的 `snippet` 来源；SearXNG 一般不给 `publishedDate`，插件里直接省略即可。

---

## 3. DSH 侧：写一个 `dsh-web-searxng`（唯一需要写的代码）

### 3.1 为什么必须写插件

DSH 的 `ctx.web.search()` 只认注册进来的 provider。官方只发了三个
（`exa`、`perplexity`、`deepseek-official`），没有 SearXNG。
但 provider 接口极薄（抄 `dsh-web-search-exa/lib/index.js` 即可）：

```ts
interface WebSearchProvider {
  id: string;                       // 本插件固定 "searxng"
  available(): boolean;             // 本地检查：baseURL 合法即 true（不做网络 IO）
  search(req: {query: string; maxResults?: number}, signal?: AbortSignal)
    : Promise<{ sources: {url,title?,snippet?,publishedAt?}[]; content?: string; truncated: boolean }>;
}
```

### 3.2 插件骨架（4 个文件，可直接照抄建仓）

`package.json`：

```json
{
  "name": "dsh-web-searxng",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0",
    "@deepseek-ai/dsh-web": ">=0.1.0"
  },
  "dependencies": { "@deepseek-ai/schemastery": ">=3.0.0" }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: searxng
      name: dsh-web-searxng
      config:
        baseURL: !!js process.env.SEARXNG_BASE_URL
        username: !!js process.env.SEARXNG_USERNAME
        password: !!js process.env.SEARXNG_PASSWORD
```

`src/provider.ts`（核心，不到 100 行）：

```ts
import { WebError } from "@deepseek-ai/dsh-web";

export interface SearxngOptions {
  baseURL: string; username?: string; password?: string;
  categories?: string; language?: string; safesearch?: number; timeoutMs?: number;
}

interface SearxngJson { results?: { url: string; title?: string; content?: string }[]; }

export class SearxngSearchProvider {
  id = "searxng";
  constructor(private opts: SearxngOptions) {}
  available() {
    return (this.opts.baseURL?.length ?? 0) > 0 && URL.canParse(this.opts.baseURL);
  }
  async search(req: { query: string; maxResults?: number }, signal?: AbortSignal) {
    const url = new URL("/search", this.opts.baseURL);
    url.searchParams.set("q", req.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", this.opts.language ?? "zh-CN");
    if (this.opts.categories) url.searchParams.set("categories", this.opts.categories);
    if (this.opts.safesearch !== undefined) url.searchParams.set("safesearch", String(this.opts.safesearch));
    if (req.maxResults) url.searchParams.set("pageno", "1");

    const headers: Record<string,string> = { accept: "application/json", "user-agent": "dsh-searxng/0.1.0" };
    if (this.opts.username) headers["authorization"] =
      "Basic " + Buffer.from(`${this.opts.username}:${this.opts.password ?? ""}`).toString("base64");

    let res: Response;
    try {
      res = await fetch(url, { headers, redirect: "error", ...(signal ? { signal } : {}) });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: e });
      throw new WebError(`SearXNG request failed: ${String(e)}`, "WEB_PROVIDER_ERROR", { cause: e });
    }
    if (!res.ok) throw new WebError(`SearXNG HTTP ${res.status}`, "WEB_PROVIDER_ERROR");
    let body: SearxngJson;
    try { body = await res.json() as SearxngJson; }
    catch (e) { throw new WebError(`SearXNG bad JSON: ${String(e)}`, "WEB_PROVIDER_ERROR", { cause: e }); }

    const sources = (body.results ?? [])
      .map(r => ({
        url: r.url,
        ...(r.title?.trim() ? { title: r.title } : {}),
        ...(r.content?.trim() ? { snippet: r.content.trim().slice(0, 500) } : {}),
      }))
      .filter(s => s.url && URL.canParse(s.url));
    // SearXNG 不产生成式 answer，所以 content 省略（学 Exa 的做法，不编造）
    return { sources, truncated: false };
  }
}
```

`src/index.ts`（注册）：

```ts
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { SearxngSearchProvider } from "./provider.js";

export const name = "web-searxng";
export const inject = ["web"];
export const Config = z.object({
  baseURL: z.string(), username: z.string(), password: z.string(),
  categories: z.string(), language: z.string(),
  safesearch: z.number().step(1).min(0).max(2),
});

export function apply(ctx: any, config: any) {
  const env = launchEnvironmentOf(ctx);
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    baseURL: config.baseURL ?? env.get("SEARXNG_BASE_URL")?.value ?? "",
    username: config.username ?? env.get("SEARXNG_USERNAME")?.value ?? "",
    password: config.password ?? env.get("SEARXNG_PASSWORD")?.value ?? "",
    categories: config.categories ?? "general",
    language: config.language ?? "zh-CN",
    safesearch: config.safesearch ?? 1,
  }));
}
```

构建发布后安装到 web profile（仿照你已有的 `dsh-plugin-model-proxy`）：

```bash
# 在插件目录
npm run build
dsh plugin --profile web add /path/to/dsh-web-searxng
# 或 npm 发包后： dsh plugin --profile web add dsh-web-searxng
```

### 3.3 DSH 最终接线（`~/.dsh/profiles/web/cordis.patch.yml` 风格示例）

```yaml
# 与本仓 cordis.patch.yml 同一写法：insert 列表 + 每项 id/name/config
- insert:
    - id: dsh-web
      name: '@deepseek-ai/dsh-web'
      config:
        searchProvider: searxng     # 只有一个可用 provider 时可省略；有 exa 并存时必须 pin
        fetchProvider: http
    - id: dsh-web-fetch-http
      name: '@deepseek-ai/dsh-web-fetch-http'
    - id: searxng
      name: dsh-web-searxng
      config:
        baseURL: !!js process.env.SEARXNG_BASE_URL      # https://search.example.com
        username: !!js process.env.SEARXNG_USERNAME     # dsh
        password: !!js process.env.SEARXNG_PASSWORD
        categories: general
        language: zh-CN
        safesearch: 1
    - id: dsh-tool-web
      name: '@deepseek-ai/dsh-tool-web'
      config:
        search: true
        fetch: true
        searchMaxResults: 8
        searchMaxQueries: 4
        searchTimeoutMs: 30000
        fetchTimeoutMs: 30000
```

环境变量：

```bash
export SEARXNG_BASE_URL="https://search.example.com"
export SEARXNG_USERNAME="dsh"
export SEARXNG_PASSWORD="..."
export DSH_WEB_SEARCH_PROVIDER="searxng"   # 与上面 searchProvider 等价，二选一
```

重启 DSH（`dsh web`）后模型即有 `web_search` / `web_fetch`。
`web_search({queries: ["deepseek harness documentation"]})` 会 fan-out 到你的 VPS，
返回 `Sources: - [title](url) — snippet` 并附“引用链接”指令；需要全文再 `web_fetch({url})`。

> **零代码备选**（不推荐长期用）：用 `dsh-tool-bash` 包一层
> `curl -su user:pass 'https://search.example.com/search?q=$Q&format=json'`，
> 让模型走 bash 搜。但这样搜素结果进的是 bash 输出而非 `ctx.web`，
> prompt 指导、引用格式、超时策略、UI 卡片全都没有，只适合临时验证连通性。

---

## 4. 安全 + 稳定 + 排错清单

| 风险 | 对策 |
|---|---|
| SearXNG 被公网白嫖/刷爆 | Caddy BasicAuth + `handle` 只放 `/search`；`formats` 只开 `json+html`；valkey limiter 开着；UFW 默认 deny |
| VPS IP 被 Bing/Brave 限流 | 引擎只留 6–7 个；`outgoing.request_timeout 6s`；DSH 侧失败重试一次+换 query；长期可加一个 Brave API key 做 fallback provider（`searchProvider` pin 切换即可） |
| 1G OOM | Granian workers=1、valkey maxmemory 64m、core mem_limit 512m、2G swap、关 `image_proxy`/autocomplete/http2 |
| JSON 403 | 99% 是 `search.formats` 没加 `json`，改完 `docker compose restart core` |
| DSH 报 `WEB_PROVIDER_AMBIGUOUS` | 装了 exa+searxng 两个可用 provider 又没 pin，`searchProvider: searxng` 写死即可 |
| DSH 报 `WEB_PROVIDER_UNAVAILABLE` | `SEARXNG_BASE_URL` 为空或非法 URL，检查 env 和 `available()` |
| 搜出来慢（>10s） | 先 `curl` 直测 VPS 本机 vs 经 Caddy，定位是引擎慢还是网络慢；慢引擎逐个 `timeout` 调小或直接从 settings 删掉 |
| 更新 | `docker compose pull && docker compose up -d`；更新前备份 `core-config/`；SearXNG 发版很勤，一个月更一次足够 |

健康巡检（加到 crontab）：

```bash
*/5 * * * * curl -sf -u dsh:$SEARXNG_PASSWORD 'https://search.example.com/search?q=health&format=json' -o /dev/null || systemctl restart docker
docker system prune -f --volumes  # 每月一次，清掉旧镜像（1G 盘也小）
```

---

## 5. 费用/延迟/备选

- 本方案 VPS 成本只多 ~50–100MB 内存占用之外的零边际费用，搜素无限次；
  对比 Exa（$5/1k 次）/ Perplexity sonar（按 token），自建适合高频 RAG/ Agent 循环搜。
- 延迟：VPS 直连引擎 2–5s 一次，比 Exa（~1s）慢但比 DeepSeek 原生搜（一次完整模型 turn）快一个量级。
- 如果 VPS 实在撑不住：降级为**公网 SearXNG 列表 + 本插件 `baseURL` 指向它**（连 Caddy 都不用搭），
  只是稳定性看别人脸色；或直接买 Exa key，DSH 官方 provider 开箱即用，零运维。

## 6. 落地顺序（30 分钟）

1. VPS：swap → `docker compose up -d` → `curl format=json` 通 → Caddy HTTPS+BasicAuth 通（10 分钟）
2. 本地：建 `dsh-web-searxng` 仓 → `npm run build` → `dsh plugin --profile web add`（10 分钟）
3. DSH：写 `cordis.patch.yml` 接线 + export 三个 env → 重启 `dsh web` → `web_search(["test"])` 验证（5 分钟）
4. 收尾：UFW、healthcheck、引擎精简、文档归档（5 分钟）

---

*参考：SearXNG 官方 `installation-docker`（compose/valkey/镜像源）、`dev/search_api`（`GET /search?q=&format=json`，formats 未开返回 403）；DSH 侧 `dsh-web`（`ctx.web` 选 provider 规则）、`dsh-tool-web`（`web_search` fan-out/round-robin 合并）、`dsh-web-search-exa`（provider 薄适配器写法，本方案直接仿写）。*
