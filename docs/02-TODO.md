# 后续开发清单
- [x] dsh 0.1.7 volatile Config 迁移（entry id → `searxng`；`apply` 收逐字段 volatile 引用；probe/instances 通道并入同一 entry 的 Config 字段，host 经 `settings.update` 回写、`loader/volatile-update` 扫描执行；client 删 `SettingsScope`、对齐 `ConfigFormSnapshot`；同步 DEP0123 修复）
- [x] `pnpm install && npm run build` 验证编译（peer 放宽到 `>=0.1.0-alpha.0` + 补 `@types/node`；`typecheck`/`build` 已过）
- [x] DSH provider 接口对齐（`implements WebSearchProvider`、子路径 baseURL、safesearch 校验、`apply` 类型化、文档 patch 示例修正）
- [x] Web 配置卡（`searxng` settings namespace + client 卡片 + 双构建；已 `make sync`，待重启 dsh web 后在设置页验证）
- [x] 社区实例选择器（searx.space 快照：`scripts/update-instances.mjs` 容错解析 + 卡片 picker；已刷出真快照 92 实例）
- [x] 代理支持（undici ProxyAgent + socks bespoke Dispatcher，与 model-proxy 同路；settings/卡片/patch/env 全链路）
- [x] SearXNG 联调：社区实例经 socks 代理返回 10 条真结果；另有实例分别返回 429（出口 IP 被限）、403（json 未开）、HTML（非 JSON 响应）
- [x] 连接测试（settings 请求/响应往返（0.1.7 起走 `searxng` entry 的 `probe*` volatile 字段）+ 卡片测试按钮 + 选择器自动测速/可用优先排序；RPC 路线因第三方 client 调不通 `ctx.remote.<ns>` 已废弃；整轮协议已直测通过，待重启 dsh web 后在设置页验证）
- [ ] `dsh web` 重启 + 卡片填写实例地址 + 代理 → 模型内 `web_search` 真机验证
- [ ] `dsh plugin --profile web add` + `searchProvider: searxng` pin + `web_search` 真机验证
- [ ] 超时/引擎精简调优（outgoing 6s，慢引擎剔除）
- [ ] 可选：fallback provider（Brave API）+ 健康检查 crontab

# opnxng.com（第三方免费实例）实测结论（2026-09-05，沙箱内探测）
- 现象：DNS 正常（108.160.166.61），但 TCP 443 建连超时，`curl` 20s exit 28、`http=000 size=0`；
  对照组 example.com 正常、google/github 等境外站同样超时 → **沙箱出境网络受限，无法定论 opnxng 本身是否存活**。
- `format=json` 是否开启、是否要鉴权：均未知（一次有效响应都没拿到）。
- 结论：**不能**把 `https://opnxng.com` 当默认/唯一实例；自建仍是主方案。
  插件侧无需改代码即可指向它（`username` 留空就不发 `Authorization` 头，见下）。
- 在可直连境外网络的机器上重测命令：
  ```bash
  curl -s -m 20 'https://opnxng.com/search?q=hello&format=json&language=zh-CN' | head -c 2000
  # 有 {"results":[...]} 即 JSON 开关是开的；403 大概率是 formats 没开 json；429/5xx = 被限流/过载
  SEARXNG_BASE_URL=https://opnxng.com node scripts/smoke.mjs "hello"
  ```
- 若可用，接入只需：`SEARXNG_BASE_URL=https://opnxng.com`，`SEARXNG_USERNAME/PASSWORD` 留空；
  `cordis.patch.yml` 的 `username/password` 置空即可。风险：随时下线/加验证/限流，
  别做唯一实例；长期仍建议自建或 searx.space 挑标注 json 可用的实例。
