#!/usr/bin/env bash
# SVL_open with the existing ChatGPT-authenticated Codex CLI.
# No API key, static IP, public MCP server or root privileges required.
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

for required in node npm python3 codex; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Missing executable: $required" >&2
    exit 1
  fi
done

if [[ -z "${CODEX_HOME:-}" ]]; then
  export CODEX_HOME="$HOME/.codex"
fi
unset OPENAI_API_KEY CODEX_API_KEY
LOGIN_STATUS="$(codex login status 2>&1 || true)"
if ! grep -qi chatgpt <<< "$LOGIN_STATUS"; then
  echo "Codex CLI requires the same Linux user's ChatGPT login." >&2
  echo "Run: codex login --device-auth" >&2
  exit 1
fi

CONFIG_DIR="$HOME/.config/svl-open"
CONFIG_FILE="$CONFIG_DIR/local-codex.env"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  python3 - "$CONFIG_FILE" <<'PY'
import os, secrets, sys
with os.fdopen(os.open(sys.argv[1], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as fp:
    fp.write("SVL_CODEX_CHAT_ACCESS_TOKEN='" + secrets.token_urlsafe(40) + "'\n")
    fp.write("SVL_OPERATOR_TOKEN='" + secrets.token_urlsafe(40) + "'\n")
PY
fi
chmod 600 "$CONFIG_FILE"
set -a
source "$CONFIG_FILE"
set +a
if [[ -z "${SVL_CODEX_CHAT_ACCESS_TOKEN:-}" || -z "${SVL_OPERATOR_TOKEN:-}" ]]; then
  echo "Private access tokens are missing from $CONFIG_FILE" >&2
  exit 1
fi
export SVL_CODEX_CHAT_ENABLED=true
export SVL_CODEX_AGENTS_ENABLED=true
export SVL_GITHUB_AUTO_SYNC=false
export SVL_GITHUB_APPLY_REMOTE_CHANGES=false

if [[ ! -d node_modules ]]; then
  npm ci
fi

echo "SVL_open ready to start with Codex CLI OAuth (same Linux runtime)."
echo "Open the private Codespaces port 3000 preview; static IP not needed."
echo "Private tokens are stored outside GitHub: $CONFIG_FILE"
echo 'Read them in your local terminal:'
echo "  source '$CONFIG_FILE'; printf 'Codex chat: %s\\nOperator: %s\\n' \"\$SVL_CODEX_CHAT_ACCESS_TOKEN\" \"\$SVL_OPERATOR_TOKEN\""
echo "Ctrl+C stops the application."
exec npm run dev
