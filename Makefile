# dsh-web-searxng — 本地开发与联调
# 用法:
#   make deps              # pnpm install（本仓用 pnpm；npm 缓存若有 root 残留会 EPERM）
#   make build / make typecheck / make clean
#   make probe             # curl 直测 SEARXNG_BASE_URL 的 ?format=json（需 export 或 .env）
#   make smoke             # 直调 provider.search()（同上；QUERY="..." 可换词）
#   make update-instances  # 拉 searx.space 社区列表刷新卡片快照（需直连外网）
#   make sync              # 本地构建后用 file: 覆盖已安装到 dsh 的插件（验证当前代码）
#   make sync PROFILE=tui  # 覆盖到指定 profile，默认 web
#   make publish           # npm publish 到官方源（先检查登录与 registry）
#
# 环境变量（export 或写本目录 .env，会被自动加载；不要提交真实密码）：
#   SEARXNG_BASE_URL=https://search.example.com  # 或 https://opnxng.com（公用，免鉴权）
#   SEARXNG_USERNAME=dsh
#   SEARXNG_PASSWORD=...
#   SEARXNG_PROXY_URL=socks5h://127.0.0.1:1080  # 出境受限时走代理（probe/smoke 同用）
#   QUERY=hello

PROFILE ?= web
DSH_HOME ?= $(HOME)/.dsh
REGISTRY := https://registry.npmjs.org/
PKG_NAME := dsh-web-searxng
PKG_DIR  := $(CURDIR)
PNPM_DIR := $(DSH_HOME)/profiles/$(PROFILE)
QUERY ?= hello

-include .env
export

SHELL := /bin/bash
.PHONY: help deps build typecheck clean probe smoke update-instances sync install publish publish-dry ensure-login ensure-registry login

help: ## 显示帮助
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

deps: ## pnpm install 安装依赖
	pnpm install

build: ## 构建 host（tsc）+ client（tsc 声明 + esbuild bundle）
	pnpm run build

typecheck: ## 仅类型检查
	pnpm run typecheck

clean: ## 清理 lib 与 .test-build
	pnpm run clean

probe: ## curl 直测 ?format=json（SEARXNG_BASE_URL 必填）
	@test -n "$(SEARXNG_BASE_URL)" || (echo "请先 export SEARXNG_BASE_URL=https://...（或写 .env）"; exit 1)
	@echo "==> GET $(SEARXNG_BASE_URL)/search?q=$(QUERY)&format=json"
	@curl -s -m 20 $(if $(SEARXNG_PROXY_URL),-x "$(SEARXNG_PROXY_URL)") $(if $(SEARXNG_USERNAME),-u "$(SEARXNG_USERNAME):$(SEARXNG_PASSWORD)") \
		'"$(SEARXNG_BASE_URL)/search?q=$(QUERY)&format=json&language=zh-CN"' | head -c 2000; echo

smoke: build ## 直调 provider.search() 联调（SEARXNG_BASE_URL 必填，QUERY 可换词，SEARXNG_PROXY_URL 可选）
	@test -n "$(SEARXNG_BASE_URL)" || (echo "请先 export SEARXNG_BASE_URL=https://...（或写 .env）"; exit 1)
	@echo "==> smoke query=[$(QUERY)] baseURL=$(SEARXNG_BASE_URL) proxy=$(SEARXNG_PROXY_URL)"
	@node scripts/smoke.mjs "$(QUERY)"

update-instances: ## 拉 searx.space 刷新社区快照（需直连外网，沙箱里跑不了）
	@echo "==> update community snapshot from searx.space"
	@node scripts/update-instances.mjs

# 1) 本地代码替换 dsh 中已安装的插件
#    原理：dsh plugin --profile <name> add file:<path> 把本目录写成该 profile 的 file: 依赖。
#    pnpm 把源码文件导入 profile/node_modules（旧版本为硬链接；pnpm v12 + APFS 下为
#    clone/拷贝，inode 不同；isolated linker 则是符号链接），改动后需重新 make sync 刷新
#    ——spec 已是 file: 时 pnpm 短路也不影响内容同步；
#    sync 真正要做的是：重新构建、把 spec 收敛为 file:（覆盖旧 registry 版本）、
#    校验 bundles 层与内容一致性，防止"装了但没被加载 / 加载的是旧拷贝"。
sync: build ## 构建后用本地 file: 覆盖到 dsh profile（默认 PROFILE=web）
	@echo "==> sync $(PKG_DIR) -> dsh profile [$(PROFILE)] ($(PNPM_DIR))"
	@test -f "$(PKG_DIR)/package.json" || (echo "package.json not found in $(PKG_DIR)"; exit 1)
	@test -d "$(PNPM_DIR)" || (echo "profile dir not found: $(PNPM_DIR)"; echo "请先 dsh --profile $(PROFILE) --dump-config 或 dsh plugin --profile $(PROFILE) add $(PKG_NAME) 创建"; exit 1)
	# 防遮蔽：bundle 按 [dsh 安装锚点, profile] 顺序解析，全局 npm i -g 的副本会优先于本地 file: 版被加载
	@if [ -f "$$(npm prefix -g)/node_modules/$(PKG_NAME)/package.json" ]; then \
		echo "!! 检测到全局副本 $$(npm prefix -g)/node_modules/$(PKG_NAME)，会遮蔽本地版本，请先: npm rm -g $(PKG_NAME)"; \
		exit 1; \
	fi
	# 必须先 remove 再 add，否则 pnpm 用缓存 lockfile 不会重新解析文件列表（新增文件不被链接）
	@echo "-> dsh plugin --profile $(PROFILE) remove + add file:$(PKG_DIR)"
	@dsh plugin --profile $(PROFILE) remove $(PKG_NAME) >/dev/null 2>&1 || true
	@dsh plugin --profile $(PROFILE) add "file:$(PKG_DIR)"
	@echo "  ✓ dsh plugin install 完成"
	# 机制级校验 1：spec 必须指向当前目录
	@if grep -q '"$(PKG_NAME)": "file:$(PKG_DIR)"' "$(PNPM_DIR)/package.json"; then \
		echo "  ✓ spec: file:$(PKG_DIR)"; \
	else \
		echo "  ! spec 未指向当前目录，请检查 pnpm add 结果"; \
	fi
	# 机制级校验 2：node_modules 产物内容必须与当前构建一致（硬链接/clone/拷贝均可；
	# pnpm v12 + APFS 下 inode 必然不同，不能用 inode 判定新旧，见 Makefile 头部说明）
	@if [ -f "$(PNPM_DIR)/node_modules/$(PKG_NAME)/lib/host/index.js" ] && cmp -s '$(PKG_DIR)/lib/host/index.js' '$(PNPM_DIR)/node_modules/$(PKG_NAME)/lib/host/index.js'; then \
		echo "  ✓ 与当前构建内容一致（硬链接/clone/拷贝均可）"; \
	else \
		echo "  ! node_modules 产物与当前构建不一致，是旧拷贝——检查构建输出与 pnpm 缓存"; \
		exit 1; \
	fi
	# 机制级校验 3：插件名必须在 dsh.profile.bundles 层，否则不会被加载
	@if grep -A8 '"bundles"' "$(PNPM_DIR)/package.json" | grep -q '"$(PKG_NAME)"'; then \
		echo "  ✓ dsh.profile.bundles 已包含 $(PKG_NAME)"; \
	else \
		echo "  ! bundles 层未包含该插件——检查 dsh plugin add 的 reconcile 结果"; \
	fi
	@echo "完成。生效方式：改动 lib 后需重启 dsh web；再 export SEARXNG_BASE_URL/USERNAME/PASSWORD 后验证："
	@echo "  模型内 web_search({queries: [\"searxng format=json\"]})，并 pin searchProvider: searxng 防 AMBIGUOUS"
	@echo "  若仍为旧版本：1) 检查是否有多个 profile（tui/web）2) 是否有全局副本遮蔽 3) 回退线上版: dsh plugin --profile $(PROFILE) add $(PKG_NAME)@latest"

install: sync ## alias of sync

login: ensure-login ## 仅执行 npm login（官方源）

ensure-registry: ## 确保 registry 指向官方源
	@echo "==> registry $(REGISTRY)"
	@npm config set registry $(REGISTRY)
	@npm config get registry

ensure-login: ensure-registry ## 确保已 npm login（官方源）
	@echo "==> 检查 npm 登录状态"
	@if npm whoami --registry $(REGISTRY) >/dev/null 2>&1; then \
		echo "  已登录: $$(npm whoami --registry $(REGISTRY)) @ $(REGISTRY)"; \
	else \
		echo "  未登录，执行 npm login --registry $(REGISTRY)"; \
		npm login --registry $(REGISTRY); \
	fi

# 2) 发布到 npm 官方源
#    步骤：ensure-login（内部会 ensure-registry + whoami/login）-> npm publish
publish: build ensure-login ## 发布到官方 npm（先 whoami/login + 强制 --registry）
	@echo "==> npm publish --registry $(REGISTRY)"
	npm publish --registry $(REGISTRY)
	@echo "✓ 已发布 $$(node -p 'require("./package.json").version') 到 $(REGISTRY)"

publish-dry: build ## 预演发布（不实际推送）
	npm publish --dry-run --registry $(REGISTRY)
