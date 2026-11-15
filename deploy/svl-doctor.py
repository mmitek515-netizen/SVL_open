#!/usr/bin/env python3
"""Read-only local SVL Python OS diagnostics for Kernel, SQLite WAL, and Ollama Daemon (11434)."""

from __future__ import annotations

import json
import urllib.request
from typing import Any


def fetch_json(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=4.0) as resp:
            return {"ok": True, "status": resp.status, "data": json.loads(resp.read().decode("utf-8"))}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def main() -> None:
    report = {
        "gateway_health": fetch_json("http://127.0.0.1:3000/api/health"),
        "python_kernel_health": fetch_json("http://127.0.0.1:8085/api/py/health"),
        "ollama_daemon_tags": fetch_json("http://127.0.0.1:11434/api/tags"),
        "ollama_daemon_ps": fetch_json("http://127.0.0.1:11434/api/ps"),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
