# claude-proxied.ps1 — run `claude` through a running repair-proxy, isolated from
# your Anthropic subscription. The isolated CLAUDE_CONFIG_DIR means the proxy's
# provider token is the sole credential (no OAuth conflict → no "Invalid API key"),
# and your subscription is never in the path.
#
# Prereq: the proxy is already running (e.g. `node dist/cli.js --config config.json`).
# Usage:  .\scripts\claude-proxied.ps1 -p "list the files here"
#         .\scripts\claude-proxied.ps1            # interactive
# Override via env: RP_PROXY_URL, RP_AUTH, RP_CONFIG_DIR.

Remove-Item Env:CLAUDECODE, Env:CLAUDE_CODE_SSE_PORT, Env:CLAUDE_CODE_ENTRYPOINT, Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:CLAUDE_CONFIG_DIR   = if ($env:RP_CONFIG_DIR) { $env:RP_CONFIG_DIR } else { Join-Path $HOME '.repair-proxy-claude' }
$env:ANTHROPIC_BASE_URL  = if ($env:RP_PROXY_URL)  { $env:RP_PROXY_URL }  else { 'http://127.0.0.1:8791' }
$env:ANTHROPIC_AUTH_TOKEN = if ($env:RP_AUTH)      { $env:RP_AUTH }       else { 'dummy' }
$env:CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
$env:CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
& claude @args
