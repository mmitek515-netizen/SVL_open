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

import hashlib
import json
import os
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
            "Wykonuje polecenie administracyjne Linux (/bin/bash) na pokładzie statku kosmicznego "
            "SVL-364 Ebon Apex przez szyfrowany mostek SSH (root@svl-364-ship:2222 · QKD-364)."
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
        self.ssh_dir = self.project_root / "data" / "ssh"
        self.ssh_dir.mkdir(parents=True, exist_ok=True)
        self.private_key_path = self.ssh_dir / "svl364_ed25519"
        self.public_key_path = self.ssh_dir / "svl364_ed25519.pub"
        self.key_fingerprint = ""
        self.public_key_text = ""
        self.recent_activity: list[dict[str, Any]] = []
        self.ssh_sessions_count = 0
        self.mcp_calls_count = 0

        self._ensure_ssh_keys()
        self._install_cli_wrappers()
        self._ensure_module_in_sqlite()

    def _ensure_ssh_keys(self) -> None:
        if not self.private_key_path.exists() or not self.public_key_path.exists():
            keygen_bin = shutil.which("ssh-keygen")
            if keygen_bin:
                try:
                    subprocess.run(
                        [
                            keygen_bin,
                            "-t",
                            "ed25519",
                            "-f",
                            str(self.private_key_path),
                            "-N",
                            "",
                            "-C",
                            "root@svl-364-ebon-apex.qkd.mesh",
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=8,
                    )
                except Exception:
                    pass

        if not self.public_key_path.exists():
            seed = hashlib.sha256(b"svl-364-ebon-apex-ed25519-qkd-key").hexdigest()
            pub_b64 = (
                "AAAAC3NzaC1lZDI1NTE5AAAAI"
                + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:43]
            )
            self.public_key_path.write_text(
                f"ssh-ed25519 {pub_b64} root@svl-364-ebon-apex.qkd.mesh\n",
                encoding="utf-8",
            )
        if not self.private_key_path.exists():
            self.private_key_path.write_text(
                "-----BEGIN OPENSSH PRIVATE KEY-----\n"
                "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n"
                "QyNTUxOQAAACBTVkwzNjRFYm9uQXBleFFrZEtleUVkMjU1MTlTaGlwUm9vdAAAAEir9svl\n"
                "-----END OPENSSH PRIVATE KEY-----\n",
                encoding="utf-8",
            )
        try:
            os.chmod(self.private_key_path, 0o600)
        except OSError:
            pass

        self.public_key_text = self.public_key_path.read_text(encoding="utf-8").strip()
        digest = hashlib.sha256(self.public_key_text.encode("utf-8")).digest()
        import base64
        b64_fp = base64.b64encode(digest).decode("ascii").rstrip("=")
        self.key_fingerprint = f"SHA256:{b64_fp}"

    def _install_cli_wrappers(self) -> None:
        bin_dir = Path(__file__).resolve().parent / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)

        ssh_script = """#!/usr/bin/env python3
import json, sys, urllib.request

cmd = " ".join(sys.argv[1:]).strip() or "uname -a && uptime"
req = urllib.request.Request(
    "http://127.0.0.1:8085/api/py/svl364/ssh/exec",
    data=json.dumps({"command": cmd, "origin": "svl364-ssh-cli"}).encode("utf-8"),
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
            "ssh_host": "svl-364-ship.qkd.mesh",
            "ssh_port": 2222,
            "ssh_user": "root",
            "ssh_mode": "qkd-local-root-bridge",
            "ssh_cipher": "chacha20-poly1305@openssh.com + QKD-BB84",
            "ssh_key_path": str(self.private_key_path),
            "ssh_pub_key_path": str(self.public_key_path),
            "ssh_fingerprint": self.key_fingerprint,
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

    def _ensure_module_in_sqlite(self) -> None:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        existing = mods.get("svl-364-ssh-mcp")
        cfg = self._default_config()
        if existing and isinstance(existing.get("config"), dict):
            merged = dict(cfg)
            merged.update(existing["config"])
            merged["ssh_fingerprint"] = self.key_fingerprint
            merged["mcp_tools_count"] = len(MCP_TOOLS_CATALOG)
            cfg = merged

        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                "Szyfrowany tunel SSH (ED25519 · root@svl-364-ship:2222) oraz serwer "
                "Model Context Protocol (MCP v2025-03-26) do bezpośredniego sterowania "
                "statkiem kosmicznym SVL-364 Ebon Apex i systemem Linux."
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
            scfg["ssh_endpoint"] = f"ssh://{cfg['ssh_user']}@{cfg['ssh_host']}:{cfg['ssh_port']}"
            scfg["ssh_fingerprint"] = self.key_fingerprint
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
        conn_uri = f"ssh://{cfg.get('ssh_user', 'root')}@{cfg.get('ssh_host', 'svl-364-ship.qkd.mesh')}:{cfg.get('ssh_port', 2222)}"
        return {
            "ok": True,
            "moduleId": "svl-364-ssh-mcp",
            "status": "ACTIVE",
            "ssh": {
                "connected": True,
                "host": cfg.get("ssh_host", "svl-364-ship.qkd.mesh"),
                "port": int(cfg.get("ssh_port", 2222)),
                "user": cfg.get("ssh_user", "root"),
                "mode": cfg.get("ssh_mode", "qkd-local-root-bridge"),
                "cipher": cfg.get("ssh_cipher", "chacha20-poly1305@openssh.com + QKD-BB84"),
                "fingerprint": self.key_fingerprint,
                "key_fingerprint": self.key_fingerprint,
                "publicKey": self.public_key_text,
                "privateKeyPath": str(self.private_key_path),
                "connectionUri": conn_uri,
                "uri": conn_uri,
                "cliCommand": "svl364-ssh 'uname -a && uptime'",
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

        cfg["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                f"Aktywny mostek SSH ({cfg['ssh_user']}@{cfg['ssh_host']}:{cfg['ssh_port']}) "
                f"oraz serwer MCP v2025-03-26 ({len(MCP_TOOLS_CATALOG)} narzędzi sterowania Linux/SVL-364)."
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
        **kwargs: Any,
    ) -> dict[str, Any]:
        clean_cmd = str(command or "").strip()
        if not clean_cmd:
            return {
                "ok": False,
                "error": "Polecenie SSH nie może być puste.",
                "exitCode": 1,
                "output": "",
                "stdout": "",
                "stderr": "Polecenie SSH nie może być puste.",
            }

        self.ssh_sessions_count += 1
        started = time.time()
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        cfg = dict(self._default_config())
        if "svl-364-ssh-mcp" in mods and isinstance(mods["svl-364-ssh-mcp"].get("config"), dict):
            cfg.update(mods["svl-364-ssh-mcp"]["config"])

        ssh_user = str(cfg.get("ssh_user") or "root")
        ssh_host = str(cfg.get("ssh_host") or "svl-364-ship.qkd.mesh")
        ssh_port = int(cfg.get("ssh_port") or 2222)
        ssh_mode = str(cfg.get("ssh_mode") or "qkd-local-root-bridge")

        env = os.environ.copy()
        env.update(
            {
                "SVL_SHIP_ID": "SVL-364",
                "SVL_SHIP_NAME": "SVL-364 Ebon Apex",
                "SVL_SSH_BRIDGE": "ACTIVE",
                "SVL_SSH_SUBSYSTEM": str(target_subsystem or "bridge"),
                "SVL_SSH_ENDPOINT": f"ssh://{ssh_user}@{ssh_host}:{ssh_port}",
                "SVL_SSH_FINGERPRINT": self.key_fingerprint,
                "SVL_MCP_ENDPOINT": "http://127.0.0.1:8085/api/py/svl364/mcp",
                "SVL_SHIP_SECTOR": str(cfg.get("ship_sector") or "SEC-364-ALPHA"),
            }
        )

        # Strip optional leading `ssh root@svl-364-ship` if user typed full ssh invocation
        exec_cmd = clean_cmd
        if exec_cmd.startswith("ssh "):
            parts = exec_cmd.split()
            idx = 1
            while idx < len(parts):
                if parts[idx] in ("-p", "-i", "-l", "-o") and idx + 1 < len(parts):
                    idx += 2
                    continue
                if parts[idx].startswith("-"):
                    idx += 1
                    continue
                idx += 1
                break
            exec_cmd = " ".join(parts[idx:]).strip() or "uname -a && uptime"

        stderr_out = ""
        try:
            proc = subprocess.run(
                ["/bin/bash", "-lc", exec_cmd],
                cwd=str(self.project_root),
                env=env,
                capture_output=True,
                text=True,
                timeout=max(2.0, min(60.0, float(timeout_sec or 15.0))),
            )
            stdout = (proc.stdout or "").strip()
            stderr_out = (proc.stderr or "").strip()
            combined = "\n".join(part for part in (stdout, stderr_out) if part).strip()
            if not combined:
                combined = f"[SSH {ssh_user}@{ssh_host}:{ssh_port}] Polecenie wykonane pomyślnie (exit 0)."
            exit_code = int(proc.returncode)
        except subprocess.TimeoutExpired:
            combined = f"[SSH {ssh_user}@{ssh_host}:{ssh_port}] Przekroczono limit czasu ({timeout_sec}s)."
            stderr_out = combined
            exit_code = 124
        except Exception as exc:
            combined = f"[SSH {ssh_user}@{ssh_host}:{ssh_port}] Błąd wykonania: {exc}"
            stderr_out = combined
            exit_code = 1

        duration_ms = round((time.time() - started) * 1000, 1)
        header = (
            f"[SSH-QKD-364 · {target_subsystem}] {ssh_user}@{ssh_host}:{ssh_port} ({ssh_mode}) "
            f"· key {self.key_fingerprint[:24]}… · {duration_ms} ms"
        )
        formatted_output = f"{header}\n$ {exec_cmd}\n{combined}"

        entry = {
            "id": f"ssh-{uuid.uuid4().hex[:10]}",
            "kind": "ssh_exec",
            "command": exec_cmd,
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
                "root",
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
            "command": exec_cmd,
            "subsystem": target_subsystem,
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "sshEndpoint": f"ssh://{ssh_user}@{ssh_host}:{ssh_port}",
            "fingerprint": self.key_fingerprint,
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
                        "sshFingerprint": self.key_fingerprint,
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
            cmd = str(arguments.get("command") or "uname -a && uptime && free -m")
            timeout_sec = float(arguments.get("timeout_sec") or 15.0)
            ssh_res = self.execute_ssh_command(cmd, timeout_sec=timeout_sec, origin=f"mcp:{origin}")
            return {
                "ok": ssh_res["ok"],
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": ssh_res["output"],
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
            summary = (
                f"[MCP · svl364_linux_telemetry] Telemetria Statku SVL-364 Ebon Apex & Linux Host:\n"
                f"• Mostek SSH: {st['ssh']['connectionUri']} ({st['ssh']['fingerprint']})\n"
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
