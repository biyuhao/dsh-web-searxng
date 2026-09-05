#!/usr/bin/env bash
# Launcher for `dsh web` with this repo's recommended environment.
#
# Usage (personal install):
#   ln -sf "$PWD/scripts/launch-web.sh" ~/.local/bin/dsh-web
#   dsh-web            # same as `dsh web`, plus the env below
#   dsh-web --help     # extra dsh args pass through via "$@"
#
# What it pins and why:
# - DSH_WEB_SEARCH_PROVIDER=searxng — default search provider for every
#   session (see README "配置": without a pin, multiple usable providers
#   resolve AMBIGUOUS, or a lone web-search-deepseek fails on missing key).
# - Proxy lines are commented out: the searxng instance proxy already lives
#   in settings (`searxng.proxyUrl`, editable on the settings card), and
#   model traffic has model-proxy rules. Uncomment only if the dsh process
#   itself needs egress (e.g. direct fetch providers).
set -euo pipefail

export DSH_WEB_SEARCH_PROVIDER="searxng"

# export HTTPS_PROXY="socks5h://127.0.0.1:1080"
# export HTTP_PROXY="socks5h://127.0.0.1:1080"
# export ALL_PROXY="socks5h://127.0.0.1:1080"

exec dsh web "$@"
