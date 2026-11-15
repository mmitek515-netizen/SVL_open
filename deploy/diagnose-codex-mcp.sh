#!/usr/bin/env bash
# Diagnostics for Codex CLI only. No OPENAI_API_KEY or Gemini API needed.
set -euo pipefail

ENV_FILE=/etc/svl-os/svl-mcp.env
ACCOUNT=svlos
CODEX_HOME_DIR=/var/lib/svl-os/codex
HOME_DIR=/var/lib/svl-os/svlos

echo '=== SVL_open / Codex CLI / MCP ==='
echo -n 'Codex binary: '
if command -v codex >/dev/null 2>&1; then codex --version; else echo 'NOT FOUND'; fi
echo -n 'systemd MCP: '
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active svl-codex-mcp.service || true
else
  echo 'systemd not installed'
fi

if ! id "$ACCOUNT" >/dev/null 2>&1; then
  echo 'ERROR: svlos user does not exist'
  exit 1
fi

echo -n 'Codex login (svlos): '
set +e
LOGIN_RESULT="$(sudo -u "$ACCOUNT" env HOME="$HOME_DIR" CODEX_HOME="$CODEX_HOME_DIR" codex login status 2>&1)"
LOGIN_CODE=$?
set -e
if (( LOGIN_CODE == 0 )) && grep -qi 'chatgpt' <<<"$LOGIN_RESULT"; then
  echo 'CHATGPT_OAUTH_OK'
else
  echo 'NOT_CHATGPT_OAUTH'
  echo 'Log in interactively with:'
  echo 'sudo -u svlos env HOME=/var/lib/svl-os/svlos CODEX_HOME=/var/lib/svl-os/codex codex login --device-auth'
fi

if [[ ! -r "$ENV_FILE" ]]; then
  echo "MCP config not readable ($ENV_FILE). Run this diagnostic with sudo."
  exit 1
fi

# Source only the local root-owned service config; never echo the token.
set -a
. "$ENV_FILE"
set +a

if [[ -z "$SVL_MCP_TOKEN" ]]; then
  echo 'ERROR: missing SVL_MCP_TOKEN'
  exit 1
fi

python3 - <<'PY'
import json
import os
import urllib.request
import urllib.error

port = os.environ.get("SVL_MCP_PORT", "8787")
token = os.environ["SVL_MCP_TOKEN"]
url = f"http://127.0.0.1:{port}/mcp"
headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}
def call(index: int, method: str, params=None):
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": index,
        "method": method,
        "params": params or {},
    }).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=7) as resp:
            result = json.load(resp)
        return result
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"MCP error ({method}): {type(exc).__name__}")
        return None

init = call(1, "initialize", {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "svl-diagnostic", "version": "1.0"}
})
if init:
    print("MCP initialize:", init.get("result", {}).get("serverInfo", {}).get("name", "UNKNOWN"))
tools = call(2, "tools/list")
if tools:
    print("MCP tools:", ", ".join(t.get("name", "?") for t in tools.get("result", {}).get("tools", [])))
status = call(3, "tools/call", {"name": "codex_status", "arguments": {}})
if status:
    try:
        val = json.loads(status["result"]["content"][0]["text"])
        print("Codex login:", val.get("authenticationMode", "unknown"))
        print("Codex installed:", val.get("installed"))
        print("Codex write enabled:", val.get("writableTasksEnabled"))
    except (KeyError, TypeError, ValueError):
        print("Codex status: unreadable response")
sync = call(4, "tools/call", {"name": "svl_sync_status", "arguments": {}})
if sync:
    try:
        val = json.loads(sync["result"]["content"][0]["text"])
        print("SVL SQLite sync revision:", val.get("serverRevision", "unavailable"))
    except (KeyError, TypeError, ValueError):
        print("SVL sync status: unreadable response")
PY
echo '=== End diagnostic (no credentials printed) ==='
