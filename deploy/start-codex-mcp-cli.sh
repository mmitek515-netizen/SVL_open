#!/usr/bin/env bash
# SVL_open MCP via CURRENT USER'S existing ChatGPT login in Codex CLI.
# Linux / Codespaces; no root, sudo, systemd or paid OpenAI API key.
# Usage: cd SVL_open && bash deploy/start-codex-mcp-cli.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

for bin in node codex python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing $bin. This launcher needs Node.js, Codex CLI, Python 3." >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  echo 'Node.js 20 or later is needed to run the MCP bridge.' >&2
  exit 1
fi

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export SVL_MCP_WORKDIR="${SVL_MCP_WORKDIR:-$ROOT_DIR}"
export SVL_MCP_HOST="${SVL_MCP_HOST:-127.0.0.1}"
export SVL_MCP_PORT="${SVL_MCP_PORT:-8787}"
export SVL_MCP_ENABLE_WRITE="${SVL_MCP_ENABLE_WRITE:-false}"

# Disallow falling back to paid API key mode.
unset OPENAI_API_KEY CODEX_API_KEY
LOGIN_STATUS="$(codex login status 2>&1 || true)"
if ! grep -qi 'chatgpt' <<< "$LOGIN_STATUS"; then
  echo 'Codex CLI must be signed in with ChatGPT, not an API key.' >&2
  echo 'Run: codex login --device-auth' >&2
  echo 'Then: codex login status' >&2
  exit 1
fi

# Locally generated MCP HTTP token; never printed; not an OpenAI API key.
SECRETS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/svl-open-mcp"
TOKEN_FILE="$SECRETS_DIR/mcp-token"
umask 077
mkdir -p "$SECRETS_DIR"
if [[ -z "${SVL_MCP_TOKEN:-}" ]]; then
  if [[ ! -s "$TOKEN_FILE" ]]; then
    python3 - "$TOKEN_FILE" <<'PY'
import os, secrets, sys
file = sys.argv[1]
fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(secrets.token_urlsafe(48))
PY
  fi
  export SVL_MCP_TOKEN="$(cat "$TOKEN_FILE")"
fi
if (( ${#SVL_MCP_TOKEN} < 32 )); then
  echo 'SVL_MCP_TOKEN must have at least 32 characters.' >&2
  exit 1
fi

if [[ "$SVL_MCP_HOST" != '127.0.0.1' && "$SVL_MCP_HOST" != '::1' ]]; then
  if [[ "${SVL_MCP_ALLOW_REMOTE:-false}" != 'true' ]]; then
    echo 'Refusing network exposure without SVL_MCP_ALLOW_REMOTE=true.' >&2
    exit 1
  fi
  echo 'WARNING: use a VPN, TLS reverse proxy, and restrict clients.' >&2
fi

echo 'Codex CLI login: ChatGPT authenticated'
echo "Workspace: $SVL_MCP_WORKDIR"
echo "MCP: http://$SVL_MCP_HOST:$SVL_MCP_PORT/mcp"
echo "MCP token: saved at $TOKEN_FILE (never printed)"
echo 'Ctrl+C stops this MCP server.'
exec node "$ROOT_DIR/mcp/codex-bridge.mjs"
