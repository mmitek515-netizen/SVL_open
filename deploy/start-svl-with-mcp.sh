#!/usr/bin/env bash
# SVL_open + local MCP bridge with the SAME existing ChatGPT-authenticated Codex CLI.
# Codespaces/local Linux; no OpenAI API key, root, stable IP, or public MCP endpoint.
# Usage: bash deploy/start-svl-with-mcp.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
pids=()

shutdown() {
  trap - EXIT INT TERM HUP
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap shutdown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo 'Starting private SVL Open gateway (port 3000) and Codex MCP (loopback port 8787).'
echo 'Both processes use the current Linux user and the same ChatGPT Codex CLI login.'
echo 'The MCP bridge remains private; do not change Codespaces port 8787 visibility to Public.'
echo 'Run the diagnostic from another terminal: python3 deploy/svl-doctor.py --logs'

bash "$ROOT_DIR/deploy/start-codex-mcp-cli.sh" &
pids+=("$!")
bash "$ROOT_DIR/deploy/start-svl-codex-only.sh" &
pids+=("$!")

# Either component exiting ends this combined session; never leave a partial
# unaudited service behind. EXIT trap terminates the remaining component.
set +e
wait -n "${pids[@]}"
status=$?
set -e
echo "An SVL_open service exited (status=$status); stopping both processes." >&2
exit "$status"
