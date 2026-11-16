#!/usr/bin/env python3
"""
SVL-364 Ebon Apex — SSH Bridge & Linux Control Model Context Protocol (MCP) Server.
Zapewnia:
1. Mostek SSH (klucz ED25519, tunel QKD-364, wykonywanie poleceń Linux jako root@svl-364-ship).
2. Serwer Model Context Protocol (MCP JSON-RPC 2.0, wersja 2025-03-26) do sterowania statkiem
   kosmicznym SVL-364 Ebon Apex, systemem Linux, tarczami, nawigacją CIC oraz infrastrukturą floty.
3. Narzędzia CLI `svl364-ssh` oraz `svl364-mcp` dostępne bezpośrednio w powłoce Linux.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import re
import shlex
import shutil
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


MCP_TOOLS_CATALOG: list[dict[str, Any]] = [
    {
        "name": "svl364_ssh_exec",
        "description": (
            "Wykonywanie zdalnych poleceń jest dostępne wyłącznie w interaktywnym terminalu SSH "
            "po potwierdzeniu operatora; wywołania MCP/AI nie mogą uruchamiać poleceń."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Polecenie powłoki Linux do wykonania na statku SVL-364 (np. 'uname -a && free -m').",
                },
                "timeout_sec": {
                    "type": "number",
                    "description": "Maksymalny czas wykonania w sekundach (domyślnie 15).",
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "svl364_starship_helm",
        "description": (
            "Steruje nawigacją statku SVL-364 Ebon Apex na mapie CIC (sektor docelowy, orbita, "
            "prędkość przelotowa, moc reaktora fuzyjnego He-3 oraz wektor podejścia)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sector": {
                    "type": "string",
                    "description": "Docelowy sektor CIC (np. 'SEC-364-ALPHA · Ziemia LEO', 'SEC-364-MARS · Olympus Prime', 'RELAY-364-OMEGA · Charon').",
                },
                "orbit_altitude_km": {
                    "type": "number",
                    "description": "Wysokość orbity w kilometrach (np. 420.4).",
                },
                "speed_kms": {
                    "type": "number",
                    "description": "Prędkość orbitalna/przelotowa w km/s (np. 14.8).",
                },
                "reactor_output_gw": {
                    "type": "number",
                    "description": "Moc wyjściowa reaktora fuzyjnego He-3 w GW (np. 4.80).",
                },
                "heading": {
                    "type": "string",
                    "description": "Wektor kursu (np. 'AZ 042.8° / INC 51.6°').",
                },
            },
        },
    },
    {
        "name": "svl364_tactical_shields",
        "description": (
            "Steruje tarczami kinetycznymi statku SVL-364, pancerzem ablacyjnym oraz trybem "
            "kwarantanny i firewalla SVL-365 Sentinel w systemie Linux."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "shields_percent": {
                    "type": "number",
                    "description": "Poziom mocy tarcz kinetycznych w % (0 - 120).",
                },
                "isolation_mode": {
                    "type": "string",
                    "description": "Tryb izolacji (np. 'quarantine_and_monitor', 'zero_trust_lockdown', 'standard_fleet_mesh').",
                },
                "defense_posture": {
                    "type": "string",
                    "description": "Status gotowości bojowej (np. 'DEFCON-4 NOMINAL', 'DEFCON-2 TACTICAL ALERT').",
                },
            },
        },
    },
    {
        "name": "svl364_linux_telemetry",
        "description": (
            "Pobiera pełną telemetrię jądra Linux statku SVL-364: CPU, GPU (Tensor Q-364), RAM, "
            "dyski, procesy oraz parametry sieci kwantowej QKD-364."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_processes": {
                    "type": "boolean",
                    "description": "Czy dołączyć listę najaktywniejszych procesów Linux.",
                },
                "include_network": {
                    "type": "boolean",
                    "description": "Czy dołączyć szczegóły interfejsów sieciowych i tunelu SSH/QKD-364.",
                },
            },
        },
    },
    {
        "name": "svl364_fleet_botany_control",
        "description": (
            "Steruje infrastrukturą floty, bioreaktorami botanicznymi (+O2/h) oraz projektami "
            "badawczymi z ETA z poziomu protokołu MCP."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "unit_id": {
                    "type": "string",
                    "description": "Identyfikator jednostki, sekcji botanicznej lub projektu (np. 'bot-364-a', 'ship-364', 'res-qkd-128').",
                },
                "status": {
                    "type": "string",
                    "description": "Nowy status operacyjny (np. 'ACTIVE', 'OPTIMAL', 'BOOST_O2').",
                },
                "eta": {
                    "type": "string",
                    "description": "Nowy czas ETA (np. '02h 15m').",
                },
            },
        },
    },
    {
        "name": "svl364_emit_iris_report",
        "description": (
            "Generuje i publikuje pełny, wielosekcyjny raport SVL_System (ze statusem SSH, MCP, "
            "telemetrią SVL-364 i flotą) na kanale Rodzina Mitek (wszyscy) przez Iris AI."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "directive": {
                    "type": "string",
                    "description": "Tytuł lub dyrektywa raportu operacyjnego.",
                },
            },
        },
    },
]


class SVL364SshMcpController:
    """Zarządza połączeniem SSH oraz serwerem MCP do sterowania statkiem SVL-364 w Linuxie."""

    def __init__(self, kernel: Any) -> None:
        self.kernel = kernel
        self.project_root = Path(__file__).resolve().parent.parent
        self.ssh_connected = False
        self.recent_activity: list[dict[str, Any]] = []
        self.ssh_sessions_count = 0
        self.mcp_calls_count = 0

        self._install_cli_wrappers()
        self._ensure_module_in_sqlite()

    def _install_cli_wrappers(self) -> None:
        bin_dir = Path(__file__).resolve().parent / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)

        ssh_script = """#!/usr/bin/env python3
import json, os, sys, urllib.request

cmd = " ".join(sys.argv[1:]).strip()
target = os.environ.get("SVL_SSH_TARGET", "Ship")
if not cmd:
    sys.stderr.write("Usage: svl364-ssh <command>\\n")
    sys.exit(2)
if not sys.stdin.isatty() or input(f"Execute on {target}? [y/N] ").strip().lower() not in ("y", "yes"):
    sys.stderr.write("SSH command cancelled.\\n")
    sys.exit(2)
req = urllib.request.Request(
    "http://127.0.0.1:8085/api/py/svl364/ssh/exec",
    data=json.dumps({"command": cmd, "confirmed": True, "origin": "svl364-ssh-cli"}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
        sys.stdout.write(payload.get("output") or "")
        if not (payload.get("output") or "").endswith("\\n"):
            sys.stdout.write("\\n")
        sys.exit(int(payload.get("exitCode") or 0))
except Exception as exc:
    sys.stderr.write(f"svl364-ssh error: {exc}\\n")
    sys.exit(1)
"""
        mcp_script = """#!/usr/bin/env python3
import json, sys, urllib.request

args = sys.argv[1:]
tool_name = args[0] if args else "svl364_linux_telemetry"
tool_args = {}
if len(args) > 1:
    raw = " ".join(args[1:]).strip()
    if raw.startswith("{"):
        try:
            tool_args = json.loads(raw)
        except Exception:
            tool_args = {"command": raw}
    else:
        tool_args = {"command": raw}

rpc_body = {
    "jsonrpc": "2.0",
    "id": "cli-1",
    "method": "tools/call",
    "params": {"name": tool_name, "arguments": tool_args},
}
req = urllib.request.Request(
    "http://127.0.0.1:8085/api/py/svl364/mcp",
    data=json.dumps(rpc_body).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
        print(json.dumps(payload, ensure_ascii=False, indent=2))
except Exception as exc:
    sys.stderr.write(f"svl364-mcp error: {exc}\\n")
    sys.exit(1)
"""
        for name, content in (("svl364-ssh", ssh_script), ("svl364-mcp", mcp_script)):
            local_target = bin_dir / name
            try:
                local_target.write_text(content, encoding="utf-8")
                os.chmod(local_target, 0o755)
            except OSError:
                pass
            usr_target = Path("/usr/local/bin") / name
            try:
                usr_target.write_text(content, encoding="utf-8")
                os.chmod(usr_target, 0o755)
            except OSError:
                pass

        current_path = os.environ.get("PATH", "")
        if str(bin_dir) not in current_path.split(os.pathsep):
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{current_path}"

    def _default_config(self) -> dict[str, Any]:
        return {
            "ssh_enabled": True,
            "ssh_host": os.environ.get("SVL_SSH_TARGET", "Ship").strip() or "Ship",
            "ssh_port": 22,
            "ssh_user": "from OpenSSH config",
            "ssh_mode": "openssh-config",
            "mcp_enabled": True,
            "mcp_server_name": "svl-364-linux-control-mcp",
            "mcp_protocol_version": "2025-03-26",
            "mcp_transport": "Streamable HTTP JSON-RPC 2.0 + Local CLI",
            "mcp_endpoint": "/api/mcp/svl364",
            "mcp_tools_count": len(MCP_TOOLS_CATALOG),
            "ship_sector": "SEC-364-ALPHA · Ziemia · Orbita LEO-364",
            "ship_orbit_km": 420.4,
            "ship_speed_kms": 14.8,
            "ship_reactor_gw": 4.80,
            "ship_shields_percent": 100,
            "ship_heading": "AZ 042.8° / INC 51.6°",
            "defense_posture": "DEFCON-4 NOMINAL",
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    def _configured_ssh_target(config: dict[str, Any]) -> str:
        target = str(
            os.environ.get("SVL_SSH_TARGET")
            or config.get("ssh_host")
            or "Ship"
        ).strip()
        if target in {"svl-364-ship.qkd.mesh", "svl-364-ship"}:
            target = "Ship"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@:-]{0,252}", target):
            raise ValueError("SVL_SSH_TARGET must be an OpenSSH alias or user@host.")
        return target

    def _ensure_module_in_sqlite(self) -> None:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        existing = mods.get("svl-364-ssh-mcp")
        cfg = self._default_config()
        if existing and isinstance(existing.get("config"), dict):
            merged = dict(cfg)
            merged.update(existing["config"])
            merged["ssh_host"] = self._configured_ssh_target(merged)
            merged["ssh_mode"] = "openssh-config"
            for key in ("ssh_key_path", "ssh_pub_key_path", "ssh_fingerprint", "ssh_cipher"):
                merged.pop(key, None)
            merged["mcp_tools_count"] = len(MCP_TOOLS_CATALOG)
            cfg = merged
        else:
            cfg["ssh_host"] = self._configured_ssh_target(cfg)

        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                f"Ręcznie zatwierdzane polecenia przez OpenSSH host alias {cfg['ssh_host']}; "
                "uwierzytelnianie i klucze pochodzą z konfiguracji OpenSSH procesu."
            ),
            config=cfg,
            source="kernel",
            origin="svl364-ssh-mcp-init",
        )

        # Zsynchronizuj również główny moduł svl-364
        svl364 = mods.get("svl-364")
        if svl364:
            scfg = dict(svl364.get("config") or {})
            scfg["ssh_bridge_active"] = True
            scfg["ssh_endpoint"] = f"ssh://{cfg['ssh_host']}"
            scfg.pop("ssh_fingerprint", None)
            scfg["mcp_bridge_active"] = True
            scfg["mcp_endpoint"] = "/api/mcp/svl364"
            scfg["mcp_tools"] = [t["name"] for t in MCP_TOOLS_CATALOG]
            self.kernel.upsert_system_module(
                module_id="svl-364",
                name=svl364.get("name") or "SVL-364 Ebon Apex — Centrum Dowodzenia",
                kind=svl364.get("kind") or "Starship Command & Telemetry",
                status="ACTIVE",
                description=svl364.get("description") or "",
                config=scfg,
                source=svl364.get("source") or "kernel",
                origin="svl364-ssh-mcp-sync",
            )

    def get_status(self) -> dict[str, Any]:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        mod = mods.get("svl-364-ssh-mcp") or {}
        cfg = dict(self._default_config())
        if isinstance(mod.get("config"), dict):
            cfg.update(mod["config"])
        target = self._configured_ssh_target(cfg)
        return {
            "ok": True,
            "moduleId": "svl-364-ssh-mcp",
            "status": "ACTIVE",
            "ssh": {
                "connected": self.ssh_connected,
                "host": target,
                "mode": "OpenSSH config/agent",
                "authentication": "OpenSSH config/agent",
                "connectionUri": f"ssh://{target}",
                "uri": f"ssh://{target}",
                "cliCommand": "ssh Ship",
                "sessionsCount": self.ssh_sessions_count,
                "invocations_count": self.ssh_sessions_count,
            },
            "mcp": {
                "active": True,
                "serverName": "svl-364-linux-control-mcp",
                "protocolVersion": "2025-03-26",
                "endpoint": "/api/mcp/svl364",
                "pythonEndpoint": "/api/py/svl364/mcp",
                "transport": "Streamable HTTP JSON-RPC 2.0",
                "tools": MCP_TOOLS_CATALOG,
                "callsCount": self.mcp_calls_count,
                "invocations_count": self.mcp_calls_count,
                "clientConfigExample": {
                    "mcpServers": {
                        "svl-364-ebon-apex": {
                            "url": "http://127.0.0.1:3000/api/mcp/svl364",
                            "transport": "streamable-http",
                        }
                    }
                },
            },
            "shipState": {
                "sector": cfg.get("ship_sector", "SEC-364-ALPHA · Ziemia · Orbita LEO-364"),
                "orbitAltitudeKm": float(cfg.get("ship_orbit_km", 420.4)),
                "speedKms": float(cfg.get("ship_speed_kms", 14.8)),
                "reactorOutputGw": float(cfg.get("ship_reactor_gw", 4.80)),
                "shieldsPercent": float(cfg.get("ship_shields_percent", 100)),
                "heading": cfg.get("ship_heading", "AZ 042.8° / INC 51.6°"),
                "defensePosture": cfg.get("defense_posture", "DEFCON-4 NOMINAL"),
            },
            "recentActivity": self.recent_activity[-20:][::-1],
            "serverRevision": self.kernel.get_server_revision(),
        }

    def update_config(
        self,
        updates: dict[str, Any],
        origin: str = "operator",
        correlation_id: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        mod = mods.get("svl-364-ssh-mcp") or {}
        cfg = dict(self._default_config())
        if isinstance(mod.get("config"), dict):
            cfg.update(mod["config"])

        for key in (
            "ssh_host",
            "ssh_port",
            "ssh_user",
            "ssh_mode",
            "ship_sector",
            "ship_orbit_km",
            "ship_speed_kms",
            "ship_reactor_gw",
            "ship_shields_percent",
            "ship_heading",
            "defense_posture",
        ):
            if key in updates and updates[key] is not None:
                cfg[key] = updates[key]

        cfg["ssh_host"] = self._configured_ssh_target(cfg)
        cfg["ssh_mode"] = "openssh-config"
        for key in ("ssh_key_path", "ssh_pub_key_path", "ssh_fingerprint", "ssh_cipher"):
            cfg.pop(key, None)
        cfg["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                f"Ręcznie zatwierdzane polecenia przez OpenSSH host alias {cfg['ssh_host']}."
            ),
            config=cfg,
            source="operator",
            origin=origin,
            correlation_id=correlation_id,
        )
        return self.get_status()

    def execute_ssh_command(
        self,
        command: str,
        timeout_sec: float = 15.0,
        origin: str = "ssh-bridge",
        target_subsystem: str = "bridge",
        correlation_id: str = "",
        confirmed: bool = False,
        **kwargs: Any,
    ) -> dict[str, Any]:
        clean_cmd = str(command or "").strip()
        if not confirmed:
            message = "Wykonanie SSH wymaga jawnego potwierdzenia w terminalu operatora."
            return {"ok": False, "error": message, "exitCode": 1, "output": "", "stdout": "", "stderr": message}
        if not clean_cmd:
            return {
                "ok": False,
                "error": "Polecenie SSH nie może być puste.",
                "exitCode": 1,
                "output": "",
                "stdout": "",
                "stderr": "Polecenie SSH nie może być puste.",
            }

        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        cfg = dict(self._default_config())
        if "svl-364-ssh-mcp" in mods and isinstance(mods["svl-364-ssh-mcp"].get("config"), dict):
            cfg.update(mods["svl-364-ssh-mcp"]["config"])

        ssh_host = self._configured_ssh_target(cfg)
        ssh_bin = shutil.which("ssh")
        if not ssh_bin:
            message = "Polecenie OpenSSH `ssh` nie jest dostępne w środowisku serwera."
            return {"ok": False, "error": message, "exitCode": 127, "output": "", "stdout": "", "stderr": message}

        self.ssh_sessions_count += 1
        started = time.time()

        stderr_out = ""
        try:
            proc = subprocess.run(
                [
                    ssh_bin,
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ConnectTimeout=10",
                    ssh_host,
                    f"/bin/bash -lc {shlex.quote(clean_cmd)}",
                ],
                cwd=str(self.project_root),
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=max(2.0, min(60.0, float(timeout_sec or 15.0))),
            )
            stdout = (proc.stdout or "").strip()
            stderr_out = (proc.stderr or "").strip()
            combined = "\n".join(part for part in (stdout, stderr_out) if part).strip()
            if not combined:
                combined = f"[SSH {ssh_host}] Polecenie zakończone kodem {proc.returncode}."
            exit_code = int(proc.returncode)
            self.ssh_connected = exit_code != 255
        except subprocess.TimeoutExpired:
            combined = f"[SSH {ssh_host}] Przekroczono limit czasu ({timeout_sec}s)."
            stderr_out = combined
            exit_code = 124
            self.ssh_connected = False
        except Exception as exc:
            combined = f"[SSH {ssh_host}] Błąd wykonania: {exc}"
            stderr_out = combined
            exit_code = 1
            self.ssh_connected = False

        duration_ms = round((time.time() - started) * 1000, 1)
        header = (
            f"[SSH · {target_subsystem}] {ssh_host} (OpenSSH config/agent) · {duration_ms} ms"
        )
        formatted_output = f"{header}\n$ {clean_cmd}\n{combined}"

        entry = {
            "id": f"ssh-{uuid.uuid4().hex[:10]}",
            "kind": "ssh_exec",
            "command": clean_cmd,
            "subsystem": target_subsystem,
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "output": formatted_output,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "origin": origin,
        }
        self.recent_activity.append(entry)

        # Log into root terminal history in SQLite so Terminals tab shows it immediately
        try:
            self.kernel.append_terminal_entry(
                "ssh",
                {
                    "type": "output",
                    "text": formatted_output,
                    "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
                },
                origin=origin,
                correlation_id=correlation_id,
            )
        except Exception:
            pass

        return {
            "ok": exit_code == 0,
            "command": clean_cmd,
            "subsystem": target_subsystem,
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "sshEndpoint": f"ssh://{ssh_host}",
            "output": formatted_output,
            "stdout": formatted_output,
            "stderr": stderr_out if exit_code != 0 else "",
            "rawOutput": combined,
            "entry": entry,
            "ssh_status": self.get_status(),
            "serverRevision": self.kernel.get_server_revision(),
        }

    def handle_mcp_jsonrpc(
        self,
        payload: dict[str, Any] | None = None,
        origin: str = "mcp-client",
        correlation_id: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        if payload is None and "request_body" in kwargs and isinstance(kwargs["request_body"], dict):
            payload = kwargs["request_body"]
        payload = payload or {}
        rpc_id = payload.get("id", 1)
        method = str(payload.get("method") or "").strip()
        params = payload.get("params") or {}

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {
                        "tools": {"listChanged": True},
                        "resources": {"listChanged": True},
                    },
                    "serverInfo": {
                        "name": "svl-364-linux-control-mcp",
                        "version": "5.6.0",
                        "ship": "SVL-364 Ebon Apex",
                    },
                },
            }

        if method == "notifications/initialized":
            return {"jsonrpc": "2.0", "id": rpc_id, "result": {"ok": True}}

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"tools": MCP_TOOLS_CATALOG},
            }

        if method == "resources/list":
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "resources": [
                        {
                            "uri": "svl364://telemetry/live",
                            "name": "Telemetria Statku SVL-364 Ebon Apex & Linux Host",
                            "mimeType": "application/json",
                        },
                        {
                            "uri": "svl364://ssh/config",
                            "name": "Konfiguracja Mostka SSH i Klucza ED25519 Statku SVL-364",
                            "mimeType": "application/json",
                        },
                    ]
                },
            }

        if method == "resources/read":
            uri = str(params.get("uri") or "svl364://telemetry/live")
            status_data = self.get_status()
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "contents": [
                        {
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": json.dumps(status_data, ensure_ascii=False, indent=2),
                        }
                    ]
                },
            }

        if method == "tools/call":
            tool_name = str(params.get("name") or "").strip()
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                arguments = {}
            call_res = self.call_mcp_tool(tool_name, arguments, origin=origin)
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": call_res["formattedText"],
                        }
                    ],
                    "isError": not call_res["ok"],
                    "structuredContent": call_res,
                },
            }

        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {
                "code": -32601,
                "message": f"Nieznana metoda MCP JSON-RPC: {method}. Dostępne: initialize, tools/list, tools/call, resources/list, resources/read.",
            },
        }

    def call_mcp_tool(
        self, tool_name: str, arguments: dict[str, Any], origin: str = "mcp-tool"
    ) -> dict[str, Any]:
        self.mcp_calls_count += 1
        started = time.time()

        if tool_name == "svl364_ssh_exec":
            cmd = str(arguments.get("command") or "")
            timeout_sec = float(arguments.get("timeout_sec") or 15.0)
            ssh_res = self.execute_ssh_command(cmd, timeout_sec=timeout_sec, origin=f"mcp:{origin}")
            return {
                "ok": ssh_res["ok"],
                "tool": tool_name,
                "arguments": arguments,
                "error": ssh_res.get("error"),
                "formattedText": ssh_res["output"] or ssh_res.get("error", ""),
                "data": ssh_res,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_starship_helm":
            updates: dict[str, Any] = {}
            if "sector" in arguments:
                updates["ship_sector"] = str(arguments["sector"])
            if "orbit_altitude_km" in arguments:
                updates["ship_orbit_km"] = float(arguments["orbit_altitude_km"])
            if "speed_kms" in arguments:
                updates["ship_speed_kms"] = float(arguments["speed_kms"])
            if "reactor_output_gw" in arguments:
                updates["ship_reactor_gw"] = float(arguments["reactor_output_gw"])
            if "heading" in arguments:
                updates["ship_heading"] = str(arguments["heading"])

            st = self.update_config(updates, origin=f"mcp:{origin}")
            ship = st["shipState"]
            summary = (
                f"[MCP · svl364_starship_helm] Zaktualizowano nawigację statku SVL-364 Ebon Apex:\n"
                f"• Sektor CIC: {ship['sector']}\n"
                f"• Orbita: {ship['orbitAltitudeKm']} km | Prędkość: {ship['speedKms']} km/s\n"
                f"• Reaktor He-3: {ship['reactorOutputGw']} GW | Wektor: {ship['heading']}"
            )
            self._record_mcp_activity(tool_name, arguments, summary, started, origin)
            return {
                "ok": True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": summary,
                "data": ship,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_tactical_shields":
            updates = {}
            if "shields_percent" in arguments:
                updates["ship_shields_percent"] = float(arguments["shields_percent"])
            if "defense_posture" in arguments:
                updates["defense_posture"] = str(arguments["defense_posture"])
            st = self.update_config(updates, origin=f"mcp:{origin}")
            isolation = str(arguments.get("isolation_mode") or "quarantine_and_monitor")
            summary = (
                f"[MCP · svl364_tactical_shields] Zaktualizowano systemy obronne SVL-364 i Linux Sentinel:\n"
                f"• Tarcze kinetyczne: {st['shipState']['shieldsPercent']}%\n"
                f"• Gotowość bojowa: {st['shipState']['defensePosture']}\n"
                f"• Izolacja SVL-365 Sentinel: {isolation}"
            )
            self._record_mcp_activity(tool_name, arguments, summary, started, origin)
            return {
                "ok": True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": summary,
                "data": st["shipState"],
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_linux_telemetry":
            ssh_res = self.execute_ssh_command(
                "uname -a && uptime && free -m && df -h /",
                timeout_sec=10.0,
                origin=f"mcp:{origin}",
            )
            st = self.get_status()
            if not ssh_res["ok"]:
                summary = (
                    "[MCP · svl364_linux_telemetry] Zdalna telemetria jest wyłączona dla wywołań MCP/AI. "
                    "Użyj interaktywnego terminala SSH i zatwierdź polecenie ręcznie."
                )
                self._record_mcp_activity(tool_name, arguments, summary, started, origin)
                return {
                    "ok": False,
                    "tool": tool_name,
                    "error": ssh_res["error"],
                    "formattedText": summary,
                    "data": {"status": st},
                    "serverRevision": self.kernel.get_server_revision(),
                }
            summary = (
                f"[MCP · svl364_linux_telemetry] Telemetria Statku SVL-364 Ebon Apex & Linux Host:\n"
                f"• Mostek SSH: {st['ssh']['connectionUri']} ({st['ssh']['authentication']})\n"
                f"• Sektor CIC: {st['shipState']['sector']} | Reaktor: {st['shipState']['reactorOutputGw']} GW | Tarcze: {st['shipState']['shieldsPercent']}%\n"
                f"--- Wyjście powłoki Linux statku ---\n{ssh_res['rawOutput']}"
            )
            self._record_mcp_activity(tool_name, arguments, summary, started, origin)
            return {
                "ok": True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": summary,
                "data": {"status": st, "linuxOutput": ssh_res["rawOutput"]},
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_fleet_botany_control":
            unit_id = str(arguments.get("unit_id") or "bot-364-a")
            new_status = str(arguments.get("status") or "OPTIMAL")
            new_eta = str(arguments.get("eta") or "02h 45m")
            summary = (
                f"[MCP · svl364_fleet_botany_control] Zaktualizowano jednostkę infrastruktury '{unit_id}':\n"
                f"• Nowy status: {new_status} | ETA: {new_eta}\n"
                f"• Bioreaktory hydroponiczne SVL-364: +830 L O2/h (100% sprawności)"
            )
            self._record_mcp_activity(tool_name, arguments, summary, started, origin)
            return {
                "ok": True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": summary,
                "data": {"unitId": unit_id, "status": new_status, "eta": new_eta},
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_emit_iris_report":
            directive = str(
                arguments.get("directive")
                or "Raport sterowania statkiem SVL-364 przez SSH i protokół MCP w Linuxie"
            )
            rep = self.kernel.generate_comprehensive_svl_system_markdown_report(
                directive=directive,
                emit_to_iris=True,
                origin=f"mcp:{origin}",
            )
            summary = rep.get("report", "Wygenerowano raport SVL_System.")
            self._record_mcp_activity(tool_name, arguments, f"Wyemitowano raport Iris AI: {directive}", started, origin)
            return {
                "ok": True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": summary,
                "data": rep,
                "serverRevision": self.kernel.get_server_revision(),
            }

        return {
            "ok": False,
            "tool": tool_name,
            "arguments": arguments,
            "formattedText": f"Nieznane narzędzie MCP: {tool_name}",
            "serverRevision": self.kernel.get_server_revision(),
        }

    def _record_mcp_activity(
        self, tool_name: str, arguments: dict[str, Any], output: str, started: float, origin: str
    ) -> None:
        duration_ms = round((time.time() - started) * 1000, 1)
        entry = {
            "id": f"mcp-{uuid.uuid4().hex[:10]}",
            "kind": "mcp_tool",
            "tool": tool_name,
            "arguments": arguments,
            "durationMs": duration_ms,
            "output": output,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "origin": origin,
        }
        self.recent_activity.append(entry)
        try:
            self.kernel.append_terminal_entry(
                "root",
                {
                    "type": "output",
                    "text": output,
                    "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
                },
                origin=origin,
            )
        except Exception:
            pass
