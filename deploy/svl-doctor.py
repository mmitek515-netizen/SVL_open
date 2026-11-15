#!/usr/bin/env python3
"""Read-only local SVL_open diagnostics for Codex-only Codespaces.

No tests, no writes, no restarts, no public IP and no token disclosure.
Run: python3 deploy/svl-doctor.py [--logs]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_RESPONSE_BYTES = 512 * 1024
ALLOWED_KEYS = ("SVL_OPERATOR_TOKEN", "SVL_CODEX_CHAT_ACCESS_TOKEN")
REDACTION = re.compile(r"(?i)(?:bearer\s+)[a-z0-9_./+=-]{12,}")
SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?:token|authorization|password|api[_-]?key)\s*[:=]\s*['\"]?[^\s,'\"]{12,}"
)


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_tokens() -> tuple[dict[str, str], str]:
    tokens = {key: os.environ.get(key, "") for key in ALLOWED_KEYS}
    config = Path.home() / ".config" / "svl-open" / "local-codex.env"
    if not config.exists():
        return tokens, "private file absent; using environment variables only"
    try:
        metadata = config.stat()
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            return tokens, "private file permissions too broad; refused reading"
        for line in config.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, raw = line.split("=", 1)
            key = key.strip()
            if key not in ALLOWED_KEYS or tokens[key]:
                continue
            parts = shlex.split(raw, posix=True)
            if len(parts) == 1:
                tokens[key] = parts[0]
    except (OSError, UnicodeError, ValueError) as exc:
        return tokens, "private file could not be parsed (" + type(exc).__name__ + ")"
    return tokens, "private local credentials file loaded (values withheld)"


def local_api(path: str, *, port: int, token: str = "", header: str = "") -> dict[str, Any]:
    url = f"http://127.0.0.1:{port}" + path
    headers = {"Accept": "application/json"}
    if token and header:
        headers[header] = token
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5.0) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return {"reachable": False, "error": "response too large"}
            value = json.loads(raw.decode("utf-8"))
            if not isinstance(value, dict):
                return {"reachable": False, "error": "invalid JSON object"}
            return {"reachable": True, "httpStatus": response.status, "data": value}
    except urllib.error.HTTPError as exc:
        # Do not read/print arbitrary response bodies that might contain secrets.
        return {"reachable": True, "httpStatus": exc.code, "error": "HTTP status from gateway"}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"reachable": False, "error": type(exc).__name__}
    except (UnicodeError, ValueError):
        return {"reachable": False, "error": "invalid JSON from gateway"}


def codex_local_login() -> dict[str, Any]:
    try:
        allowed_env = (
            "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL",
            "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
            "CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
            "SSL_CERT_FILE", "SSL_CERT_DIR",
        )
        child_env = {
            key: os.environ[key]
            for key in allowed_env if os.environ.get(key)
        }
        status = subprocess.run(
            ["codex", "login", "status"],
            capture_output=True, text=True, timeout=8, check=False,
            env=child_env,
        )
    except FileNotFoundError:
        return {"installed": False, "chatgptOAuth": False, "state": "CLI missing"}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "installed": None, "chatgptOAuth": False,
            "state": type(exc).__name__,
        }
    ok = status.returncode == 0 and re.search(
        r"logged in (?:using|with) chatgpt\b",
        status.stdout + "\n" + status.stderr, re.IGNORECASE,
    ) is not None
    return {
        "installed": True, "chatgptOAuth": ok,
        "state": "authenticated" if ok else "not verified",
        "exitCode": status.returncode,
    }


def redact(value: str, tokens: dict[str, str]) -> str:
    result = REDACTION.sub("Bearer [REDACTED]", str(value))
    result = SECRET_ASSIGNMENT.sub("[REDACTED_CREDENTIAL]", result)
    for secret in tokens.values():
        if len(secret) >= 8:
            result = result.replace(secret, "[REDACTED]")
    return result[:600]


def local_mcp_token() -> tuple[str, str]:
    """Read only the current user's private MCP token, never its value in output."""
    env_token = os.environ.get("SVL_MCP_TOKEN", "")
    if env_token:
        return (env_token, "environment") if len(env_token) >= 32 else ("", "invalid environment token")
    config_root = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    token_file = config_root / "svl-open-mcp" / "mcp-token"
    try:
        if token_file.is_symlink():
            return "", "refusing symlinked MCP token file"
        if not token_file.is_file():
            return "", "private MCP token file not found for this user"
        if stat.S_IMODE(token_file.stat().st_mode) & 0o077:
            return "", "MCP token file has unsafe permissions"
        value = token_file.read_text(encoding="utf-8").strip()
        if len(value) < 32:
            return "", "MCP token is too short"
        return value, "private user token file"
    except (OSError, UnicodeError, ValueError):
        return "", "MCP token file could not be read"


def mcp_rpc(port: int, token: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    """JSON-RPC on the actual Streamable HTTP /mcp route (not legacy /sse)."""
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    }).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/mcp",
        data=payload, headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=25 if method == "tools/call" else 5) as resp:
            raw = resp.read(65537)
            if len(raw) > 65536:
                return {"reachable": True, "httpStatus": resp.status, "error": "response too large"}
            result = json.loads(raw.decode("utf-8"))
            if not isinstance(result, dict):
                return {"reachable": True, "httpStatus": resp.status, "error": "unexpected RPC response"}
            return {"reachable": True, "httpStatus": resp.status, "data": result}
    except urllib.error.HTTPError as exc:
        return {"reachable": True, "httpStatus": exc.code, "error": "HTTP " + str(exc.code)}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"reachable": False, "error": type(exc).__name__}
    except (UnicodeError, ValueError):
        return {"reachable": True, "error": "invalid JSON response"}


def mcp_diagnostics(port: int) -> dict[str, Any]:
    token, token_state = local_mcp_token()
    report: dict[str, Any] = {
        "endpoint": f"http://127.0.0.1:{port}/mcp",
        "tokenState": token_state,
        "legacySseEndpoint": "/sse is not supported; 404 is expected there",
    }
    initial = mcp_rpc(port, token, "initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "svl-doctor", "version": "1.0"},
    })
    report["reachable"] = initial["reachable"]
    report["httpStatus"] = initial.get("httpStatus")
    if initial.get("httpStatus") == 401:
        report["authenticated"] = False
        report["diagnosis"] = "MCP requires a valid private Bearer token"
        return report
    if initial.get("httpStatus") == 404:
        report["authenticated"] = False
        report["diagnosis"] = "Wrong /mcp route or another service on this port"
        return report
    if initial.get("httpStatus") != 200:
        report["authenticated"] = False
        report["diagnosis"] = initial.get("error", "MCP not available")
        return report
    data = initial.get("data") or {}
    if data.get("error"):
        report["authenticated"] = False
        report["diagnosis"] = "MCP initialize returned an RPC error"
        return report
    report["authenticated"] = True
    report["server"] = (data.get("result") or {}).get("serverInfo", {}).get("name")
    listed = mcp_rpc(port, token, "tools/list", {})
    report["tools"] = [
        entry.get("name")
        for entry in (listed.get("data") or {}).get("result", {}).get("tools", [])
        if isinstance(entry, dict)
    ]
    status = mcp_rpc(port, token, "tools/call", {
        "name": "codex_status", "arguments": {},
    })
    try:
        content = status["data"]["result"]["content"][0]["text"]
        details = json.loads(content)
        report["codex"] = {
            "installed": details.get("installed"),
            "loggedIn": details.get("loggedIn"),
            "authenticationMode": details.get("authenticationMode"),
            "writableTasksEnabled": details.get("writableTasksEnabled"),
        }
    except (KeyError, TypeError, ValueError, IndexError):
        report["codex"] = {"diagnosis": "codex_status tool unavailable or failed"}
    return report


def create_report(port: int, logs: bool, limit: int, mcp_port: int = 8787) -> dict[str, Any]:
    credentials, credentials_state = local_tokens()
    operator = credentials.get("SVL_OPERATOR_TOKEN", "")
    codex_access = credentials.get("SVL_CODEX_CHAT_ACCESS_TOKEN", "")
    report: dict[str, Any] = {
        "checkedAt": now_utc(),
        "scope": "localhost-only, read-only diagnostics, no tests",
        "gatewayPort": port,
        "credentials": {
            "state": credentials_state,
            "operatorConfigured": bool(operator),
            "codexAccessConfigured": bool(codex_access),
        },
        "codexLocal": codex_local_login(),
        "mcp": mcp_diagnostics(mcp_port),
    }

    version = local_api("/api/deployment-info", port=port)
    report["gateway"] = {
        "reachable": version["reachable"],
        "httpStatus": version.get("httpStatus"),
        "revision": (version.get("data") or {}).get("commit"),
        "revisionSource": (version.get("data") or {}).get("source"),
        "error": version.get("error"),
    }
    if not version["reachable"]:
        report["note"] = "SVL gateway not reachable on this local port; GitHub main is not proof of deployment"
        return report

    # Explicitly detect older unsafe gateway builds that accepted an empty token.
    anonymous_status = local_api("/api/operator/status", port=port)
    operator_status = local_api(
        "/api/operator/status", port=port,
        token=operator, header="X-SVL-Operator-Token",
    )
    anonymous_accepted = (
        anonymous_status.get("httpStatus") == 200
        and bool((anonymous_status.get("data") or {}).get("authenticated"))
    )
    report["operator"] = {
        "authenticated": bool((operator_status.get("data") or {}).get("authenticated")),
        "httpStatus": operator_status.get("httpStatus"),
        "anonymousDenied": anonymous_status.get("httpStatus") == 401,
        "securityWarning": "CRITICAL: gateway accepts requests without operator token"
        if anonymous_accepted else None,
    }

    codex = local_api(
        "/api/codex-chat/status", port=port,
        token=codex_access, header="X-SVL-Codex-Access",
    )
    codex_info = codex.get("data") or {}
    activity = codex_info.get("activity") or {}
    report["codexGateway"] = {
        "enabled": codex_info.get("enabled"),
        "accessConfigured": codex_info.get("accessConfigured"),
        "authenticated": codex_info.get("authenticated"),
        "loggedIn": codex_info.get("loggedIn"),
        "reason": redact(codex_info.get("reason") or "", credentials),
        "running": activity.get("running"),
        "outcome": activity.get("outcome"),
        "lastAttemptAt": activity.get("lastAttemptAt"),
        "lastSuccessAt": activity.get("lastSuccessAt"),
        "lastFailureAt": activity.get("lastFailureAt"),
        "httpStatus": codex.get("httpStatus"),
    }

    health = local_api(
        "/api/py/health", port=port,
        token=operator, header="X-SVL-Operator-Token",
    )
    hdata = health.get("data") or {}
    report["pythonKernel"] = {
        "reachable": health["reachable"] and health.get("httpStatus") == 200,
        "httpStatus": health.get("httpStatus"),
        "serverRevision": hdata.get("serverRevision"),
    }

    agents = local_api(
        "/api/py/agents/status", port=port,
        token=operator, header="X-SVL-Operator-Token",
    )
    adata = agents.get("data") or {}
    report["agents"] = {
        "reachable": agents["reachable"] and agents.get("httpStatus") == 200,
        "executionEngine": adata.get("execution_engine"),
        "workers": [
            {
                "name": item.get("canonical_name"),
                "status": item.get("status"),
                "phase": item.get("worker_phase"),
                "pid": item.get("pid"),
                "queueDepth": item.get("queue_depth"),
            }
            for item in adata.get("agents", [])
            if isinstance(item, dict)
        ][:5],
    }

    if logs:
        runtime = local_api(
            "/api/runtime/logs?limit=" + str(limit), port=port,
            token=operator, header="X-SVL-Operator-Token",
        )
        payload = runtime.get("data") or {}
        report["runtime"] = {
            "httpStatus": runtime.get("httpStatus"),
            "pythonPid": payload.get("pythonPid"),
            "pythonRestartAttempt": payload.get("pythonRestartAttempt"),
            "lines": [
                {
                    "timestamp": row.get("timestamp"),
                    "service": row.get("service"),
                    "level": row.get("level"),
                    "message": redact(str(row.get("message") or ""), credentials),
                }
                for row in payload.get("lines", [])
                if isinstance(row, dict)
            ][-limit:],
        }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="SVL_open: read-only Codespaces diagnostics; no tests or token output"
    )
    parser.add_argument("--logs", action="store_true", help="include recent redacted Python logs")
    parser.add_argument("--limit", type=int, default=30, help="last N log lines (1–100)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "3000")))
    parser.add_argument("--mcp-port", type=int, default=int(os.environ.get("SVL_MCP_PORT", "8787")))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.mcp_port <= 65535:
        parser.error("invalid port number")
    print(json.dumps(
        create_report(args.port, args.logs, min(100, max(1, args.limit)), args.mcp_port),
        indent=2, ensure_ascii=False,
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
