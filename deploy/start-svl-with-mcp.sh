#!/usr/bin/env bash
# SVL Python OS — Gateway (port 3000) + Python Kernel & SVL-364 SSH/MCP Bridge (port 8085) + Ollama 3.2 Vision (port 11434)
# Usage: bash deploy/start-svl-with-mcp.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting SVL Python OS Gateway (port 3000), SVL-364 SSH/MCP Bridge (/api/mcp/svl364), and Ollama 3.2 Vision (port 11434)..."
echo "Run diagnostics from another terminal: python3 deploy/svl-doctor.py"

exec npm run dev
