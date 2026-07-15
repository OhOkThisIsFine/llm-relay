#!/usr/bin/env bash
# claude-proxied.sh — run `claude` through a running repair-proxy, isolated from
# your Anthropic subscription. The isolated CLAUDE_CONFIG_DIR makes the proxy's
# provider token the sole credential (no OAuth conflict → no "Invalid API key"),
# and your subscription is never in the path.
#
# Prereq: the proxy is already running (e.g. `node dist/cli.js --config config.json`).
# Usage:  ./scripts/claude-proxied.sh -p "list the files here"
#         ./scripts/claude-proxied.sh            # interactive
# Override via env: RP_PROXY_URL, RP_AUTH, RP_CONFIG_DIR.
exec env -u CLAUDECODE -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_ENTRYPOINT -u ANTHROPIC_API_KEY \
  CLAUDE_CONFIG_DIR="${RP_CONFIG_DIR:-$HOME/.repair-proxy-claude}" \
  ANTHROPIC_BASE_URL="${RP_PROXY_URL:-http://127.0.0.1:8791}" \
  ANTHROPIC_AUTH_TOKEN="${RP_AUTH:-dummy}" \
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 \
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  claude "$@"
