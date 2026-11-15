#!/usr/bin/env bash
# Install isolated Codex CLI MCP bridge for existing SVL_open (Debian 13).
# No OpenAI API key. ChatGPT login must be completed by svlos separately.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Use sudo bash deploy/install-codex-mcp.sh' >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR=/opt/svl-python-os
ENV_FILE=/etc/svl-os/svl-mcp.env
SERVICE=svl-codex-mcp.service

if ! id svlos >/dev/null 2>&1; then
  echo 'svlos account is absent; install SVL_open Debian 13 first.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required; run the SVL_open Debian installer first.' >&2
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  echo 'Node.js >= 20 is required.' >&2
  exit 1
fi
if ! command -v codex >/dev/null 2>&1; then
  echo 'Install official Codex first: sudo npm install -g @openai/codex' >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo 'util-linux flock is required to serialize the shared Codex account.' >&2
  exit 1
fi

install -d -o root -g svlos -m 0750 /etc/svl-os
install -d -o svlos -g svlos -m 0700 /var/lib/svl-os/svlos
install -d -o svlos -g svlos -m 0700 /var/lib/svl-os/codex
install -d -o svlos -g svlos -m 0750 "$INSTALL_DIR/mcp"

SOURCE="$ROOT_DIR/mcp/codex-bridge.mjs"
TARGET="$INSTALL_DIR/mcp/codex-bridge.mjs"
if [[ "$(readlink -f "$SOURCE")" != "$(readlink -f "$TARGET" 2>/dev/null || echo '')" ]]; then
  install -o root -g svlos -m 0640 "$SOURCE" "$TARGET"
fi
install -o root -g root -m 0644 \
  "$ROOT_DIR/deploy/systemd/$SERVICE" "/etc/systemd/system/$SERVICE"

if [[ ! -e "$ENV_FILE" ]]; then
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')"
  ( umask 077; cat > "$ENV_FILE" <<EOF
# Separate from SVL_OPERATOR_TOKEN and ChatGPT authentication.
SVL_MCP_TOKEN=$TOKEN
SVL_MCP_HOST=127.0.0.1
SVL_MCP_PORT=8787
SVL_MCP_ALLOW_REMOTE=false
SVL_MCP_WORKDIR=/opt/svl-python-os
SVL_MCP_ENABLE_WRITE=false
CODEX_HOME=/var/lib/svl-os/codex
EOF
  )
  echo "Created $ENV_FILE with a new private MCP bearer token."
else
  echo "$ENV_FILE already exists; kept existing settings and secrets."
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl restart "$SERVICE"
echo
echo "Service: $(systemctl is-active "$SERVICE" || true)"
echo "MCP local URL: http://127.0.0.1:8787/mcp"
echo
echo 'IMPORTANT: A ChatGPT login by root or a different Linux user is NOT visible to svlos.'
echo 'Complete device flow with the same CODEX_HOME used by this service:'
echo '  sudo -u svlos env HOME=/var/lib/svl-os/svlos CODEX_HOME=/var/lib/svl-os/codex codex login --device-auth'
echo 'Then verify (credentials are not printed):'
echo '  sudo -u svlos env HOME=/var/lib/svl-os/svlos CODEX_HOME=/var/lib/svl-os/codex codex login status'
echo
echo "Check service: sudo journalctl -u $SERVICE -n 40 --no-pager"
echo 'For LAN binding, set SVL_MCP_HOST=0.0.0.0 and SVL_MCP_ALLOW_REMOTE=true'
echo 'in /etc/svl-os/svl-mcp.env, restrict firewall to trusted IPs, then restart.'
echo 'For connecting ChatGPT remotely, prefer an authenticated HTTPS reverse proxy or Secure MCP Tunnel.'
