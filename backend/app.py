#!/usr/bin/env python3
"""
SVL PYTHON OS — FASTAPI & ASYNCIO BACKEND SERVER
Provides:
1. Full FastAPI application definition (when FastAPI/Pydantic are installed on Debian 13 Trixie).
2. Zero-dependency asyncio HTTP server fallback on port 8085 so the Python backend runs natively
   in environments without pip preinstalled while executing the exact same Python kernel, SQLite DB,
   multiprocessing agent workers, and Spherical Event Bus.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Ensure backend directory is in sys.path
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents_runtime import CANONICAL_SVL_AGENTS, SVLAgentOrchestrator
from hyperspace_engine import BinaryHyperspaceKernel, WithoutNlpHarmonicEngine
from spherical_bus import SphericalEventBus
from svl_core import SVLProtectedVariable, SVLSystemKernel, TopologicalInfinityEngine, VisualScope


class SVLBackendRuntime:
    """Central runtime instance combining SVLSystemKernel, SphericalEventBus, Agents, and Hyperspace engines."""

    def __init__(self) -> None:
        self.boot_time = time.time() if "time" in globals() else __import__("time").time()
        self.kernel = SVLSystemKernel()
        self.bus = SphericalEventBus()
        self.orchestrator = SVLAgentOrchestrator(self.kernel, self.bus)
        self.hyperspace = BinaryHyperspaceKernel(dimensions=128)
        self.without_nlp = WithoutNlpHarmonicEngine()
        self.ollama_host = self._load_persisted_ollama_host()
        self.ollama_pull_state: dict[str, Any] = {
            "active": False,
            "model": None,
            "status": "idle",
            "percent": 0.0,
            "error": None,
            "updated_at": None,
        }
        self.repl_globals: dict[str, Any] = {
            "__builtins__": __builtins__,
            "math": math,
            "json": json,
            "datetime": datetime,
            "VisualScope": VisualScope,
            "SVLProtectedVariable": SVLProtectedVariable,
            "TopologicalInfinityEngine": TopologicalInfinityEngine,
            "SVLSystemKernel": SVLSystemKernel,
            "BinaryHyperspaceKernel": BinaryHyperspaceKernel,
            "WithoutNlpHarmonicEngine": WithoutNlpHarmonicEngine,
            "kernel": self.kernel,
            "bus": self.bus,
            "hyperspace": self.hyperspace,
            "without_nlp": self.without_nlp,
        }
        self._register_initial_services()

    def _load_persisted_ollama_host(self) -> str:
        default_host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        try:
            import sqlite3
            with sqlite3.connect(self.kernel.db_path) as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
                row = conn.execute(
                    "SELECT value FROM runtime_settings WHERE key = 'ollama_host'"
                ).fetchone()
                if row and row[0]:
                    return str(row[0]).rstrip("/")
        except Exception:
            pass
        return default_host

    def set_ollama_host(self, new_host: str) -> dict[str, Any]:
        clean = (new_host or "").strip().rstrip("/")
        if not (clean.startswith("http://") or clean.startswith("https://")):
            raise ValueError("Adres OLLAMA_HOST musi zaczynać się od http:// lub https://")
        self.ollama_host = clean
        try:
            import sqlite3
            with sqlite3.connect(self.kernel.db_path) as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
                conn.execute(
                    "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                    ("ollama_host", clean, datetime.now(timezone.utc).isoformat()),
                )
                conn.commit()
        except Exception:
            pass
        self.kernel.record_audit("operator", "OLLAMA_HOST_UPDATE", clean, "OK", f"Zmieniono OLLAMA_HOST na {clean}")
        return self.probe_ollama_status()

    def _register_initial_services(self) -> None:
        self.kernel.register_service(
            "svl-python-kernel",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/kernel/report",
            {"python_version": platform.python_version(), "sqlite_db": str(self.kernel.db_path)},
        )
        self.kernel.register_service(
            "spherical-event-bus",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/agents/status",
            {"mode": "asyncio_pubsub_circuit_breaker"},
        )
        self.kernel.register_service(
            "binary-hyperspace-engine",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/hyperspace/compute",
            {"dimensions": 128, "without_nlp_version": self.without_nlp.version},
        )

    def probe_host_environment(self) -> dict[str, Any]:
        os_release: dict[str, str] = {}
        try:
            with open("/etc/os-release", "r", encoding="utf-8") as f:
                for line in f:
                    if "=" in line:
                        k, v = line.strip().split("=", 1)
                        os_release[k] = v.strip('"')
        except OSError:
            pass

        gpu_available = False
        gpu_info = "Brak wykrytego GPU (środowisko kontenerowe CPU)"
        if shutil.which("nvidia-smi"):
            try:
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"],
                    timeout=2.0,
                    text=True,
                ).strip()
                if out:
                    gpu_available = True
                    gpu_info = out
            except Exception:
                pass

        systemd_pid1 = False
        try:
            comm = Path("/proc/1/comm").read_text(encoding="utf-8").strip()
            systemd_pid1 = comm == "systemd"
        except OSError:
            pass

        telemetry = self.kernel.operator.scope.collect_host_telemetry()
        return {
            "os_pretty_name": os_release.get("PRETTY_NAME", platform.platform()),
            "os_version_id": os_release.get("VERSION_ID", "unknown"),
            "os_codename": os_release.get("VERSION_CODENAME", "unknown"),
            "is_debian_13_trixie": os_release.get("VERSION_ID") == "13" or "trixie" in os_release.get("VERSION_CODENAME", "").lower(),
            "kernel_release": platform.release(),
            "architecture": platform.machine(),
            "python_version": platform.python_version(),
            "systemd_active_as_pid1": systemd_pid1,
            "gpu_available": gpu_available,
            "gpu_info": gpu_info,
            "telemetry": telemetry,
        }

    def _probe_single_ollama_endpoint(self, base_url: str, timeout: float = 2.0) -> tuple[bool, list[dict[str, Any]], Optional[str]]:
        models: list[dict[str, Any]] = []
        try:
            req = urllib.request.Request(f"{base_url}/api/tags", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for m in data.get("models", []):
                    m_name = m.get("name", "")
                    details = m.get("details", {})
                    families = details.get("families") or []
                    has_vision = any(
                        kw in m_name.lower() or kw in " ".join(families).lower()
                        for kw in ("vl", "vision", "llava", "minicpm-v", "pixtral", "gemma3")
                    )
                    models.append({
                        "name": m_name,
                        "size_gb": round(m.get("size", 0) / (1024**3), 2),
                        "parameter_size": details.get("parameter_size", "unknown"),
                        "quantization": details.get("quantization_level", "unknown"),
                        "vision_supported": has_vision,
                    })
            return True, models, None
        except Exception as exc:
            return False, [], str(exc)

    def probe_ollama_status(self) -> dict[str, Any]:
        ollama_host = (self.ollama_host or os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")).rstrip("/")
        preferred_model = os.environ.get("OLLAMA_PREFERRED_MODEL", "llama3.2-vision:11b")
        binary_installed = shutil.which("ollama") is not None

        reachable, models, error_msg = self._probe_single_ollama_endpoint(ollama_host, timeout=2.0)
        if not reachable and ollama_host == "http://127.0.0.1:11434":
            docker_reachable, docker_models, _ = self._probe_single_ollama_endpoint(
                "http://host.docker.internal:11434", timeout=0.8
            )
            if docker_reachable:
                ollama_host = "http://host.docker.internal:11434"
                self.ollama_host = ollama_host
                reachable = True
                models = docker_models
                error_msg = None

        loaded_models: list[str] = []
        if reachable:
            try:
                req_ps = urllib.request.Request(f"{ollama_host}/api/ps", headers={"Accept": "application/json"})
                with urllib.request.urlopen(req_ps, timeout=1.2) as r_ps:
                    ps_data = json.loads(r_ps.read().decode("utf-8"))
                    loaded_models = [str(m.get("name", "")) for m in ps_data.get("models", []) if m.get("name")]
            except Exception:
                pass

        telemetry = self.kernel.operator.scope.collect_host_telemetry()
        return {
            "ollama_host": ollama_host,
            "binary_installed": binary_installed,
            "daemon_reachable": reachable,
            "preferred_14b_vision_model": preferred_model,
            "recommended_vision_model": "llama3.2-vision:11b",
            "models": models,
            "loaded_models": loaded_models,
            "vision_models_available": [m["name"] for m in models if m["vision_supported"]],
            "pull_state": self.ollama_pull_state,
            "host_ram_total_mb": telemetry["ram_total_mb"],
            "host_ram_available_mb": telemetry["ram_available_mb"],
            "host_disk_free_gb": telemetry["disk_free_gb"],
            "error": error_msg,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    def pull_ollama_model(self, model_name: str) -> tuple[int, dict[str, Any]]:
        clean_model = (model_name or "").strip() or "llama3.2-vision:11b"
        ollama_host = self.ollama_host.rstrip("/")

        if self.ollama_pull_state.get("active"):
            return 202, {
                "ok": True,
                "already_running": True,
                "pull_state": self.ollama_pull_state,
                "status": self.probe_ollama_status(),
            }

        reachable, _, err = self._probe_single_ollama_endpoint(ollama_host, timeout=2.0)
        if not reachable:
            return 502, {
                "ok": False,
                "error": f"Serwer Ollama pod adresem {ollama_host} nie odpowiada ({err}).",
            }

        self.ollama_pull_state = {
            "active": True,
            "model": clean_model,
            "status": f"Rozpoczynanie pobierania {clean_model}...",
            "percent": 0.0,
            "error": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        def _worker() -> None:
            try:
                payload = json.dumps({"model": clean_model, "stream": True}).encode("utf-8")
                req = urllib.request.Request(
                    f"{ollama_host}/api/pull",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=1800.0) as resp:
                    for raw_line in resp:
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if not line:
                            continue
                        try:
                            evt = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if evt.get("error"):
                            raise RuntimeError(str(evt["error"]))
                        total = evt.get("total") or 0
                        completed = evt.get("completed") or 0
                        pct = round((completed / total) * 100.0, 1) if total > 0 else self.ollama_pull_state.get("percent", 0.0)
                        self.ollama_pull_state = {
                            "active": True,
                            "model": clean_model,
                            "status": str(evt.get("status", "pobieranie...")),
                            "percent": pct,
                            "error": None,
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }
                self.ollama_pull_state = {
                    "active": False,
                    "model": clean_model,
                    "status": f"Pobrano pomyślnie: {clean_model}",
                    "percent": 100.0,
                    "error": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                self.kernel.record_audit("operator", "OLLAMA_PULL", clean_model, "OK", f"Pobrano model {clean_model}")
            except Exception as exc:
                self.ollama_pull_state = {
                    "active": False,
                    "model": clean_model,
                    "status": "Błąd pobierania",
                    "percent": self.ollama_pull_state.get("percent", 0.0),
                    "error": str(exc),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }

        import threading
        threading.Thread(target=_worker, daemon=True).start()
        return 202, {
            "ok": True,
            "started": True,
            "model": clean_model,
            "pull_state": self.ollama_pull_state,
            "status": self.probe_ollama_status(),
        }

    def probe_codex_status(self) -> dict[str, Any]:
        codex_bin = shutil.which("codex")
        git_bin = shutil.which("git")
        git_branch = "main"
        try:
            git_branch = subprocess.check_output(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                timeout=2.0,
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip() or "main"
        except Exception:
            pass

        return {
            "codex_cli_installed": codex_bin is not None,
            "codex_binary_path": codex_bin,
            "device_login_command": "codex login --device",
            "chatgpt_oauth_note": (
                "Logowanie przez konto ChatGPT (codex login --device) autoryzuje sesję CLI OAuth, "
                "ale NIE jest równoznaczne z kluczem płatnego OpenAI API (OPENAI_API_KEY)."
            ),
            "openai_api_key_configured": bool(os.environ.get("OPENAI_API_KEY", "").strip()),
            "git_available": git_bin is not None,
            "active_branch": git_branch,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    def execute_python_repl(self, code: str) -> dict[str, Any]:
        """Executes real Python 3 code in the kernel's interactive session and returns stdout/stderr/result."""
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        result_repr: Optional[str] = None
        ok = True

        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                try:
                    compiled = compile(code, "<svl_python_console>", "eval")
                    val = eval(compiled, self.repl_globals)
                    if val is not None:
                        result_repr = repr(val)
                except SyntaxError:
                    compiled = compile(code, "<svl_python_console>", "exec")
                    exec(compiled, self.repl_globals)
        except Exception:
            ok = False
            stderr_buf.write(traceback.format_exc())

        out = stdout_buf.getvalue()
        if result_repr is not None:
            out = f"{out}{result_repr}\n" if out else f"{result_repr}\n"

        self.kernel.record_audit("operator", "PYTHON_REPL_EXEC", "<svl_python_console>", "OK" if ok else "ERROR", code[:120])
        return {
            "ok": ok,
            "stdout": out,
            "stderr": stderr_buf.getvalue(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


runtime = SVLBackendRuntime()


async def handle_api_request(method: str, path: str, query: dict[str, str], body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Unified async router used by both FastAPI and the built-in asyncio HTTP server."""
    if method == "GET" and path == "/api/py/health":
        return 200, {
            "status": "ONLINE",
            "system": runtime.kernel.sys_version.value,
            "operator": runtime.kernel.operator.value,
            "host": runtime.probe_host_environment(),
            "ollama": runtime.probe_ollama_status(),
            "codex": runtime.probe_codex_status(),
            "security": {
                "token_source": runtime.kernel.token_source,
                "token_length": len(runtime.kernel.operator_token),
                "hardcoded_token_removed": True,
                "demo_operator_token_for_local_testing": runtime.kernel.operator_token,
            },
        }

    if method == "GET" and path == "/api/py/kernel/report":
        include_demo = query.get("include_demo", "false").lower() in ("1", "true", "yes")
        raw_report = json.loads(runtime.kernel.generate_system_status_report(include_demo_history=include_demo))
        return 200, {
            "report": raw_report,
            "visual_scopes": VisualScope.get_registry_snapshot(),
            "protected_variables": {
                k: v.to_metadata() for k, v in runtime.kernel.protected_variables.items()
            },
            "audit_logs": runtime.kernel.get_audit_logs(limit=40),
        }

    if method == "POST" and path == "/api/py/kernel/evaluate-topology":
        raw_start = body.get("x_start", "-inf")
        raw_end = body.get("x_end", "inf")
        try:
            x_start = float("-inf") if str(raw_start).lower() in ("-inf", "-infinity") else (
                float("inf") if str(raw_start).lower() in ("inf", "+inf", "infinity") else float(raw_start)
            )
            x_end = float("-inf") if str(raw_end).lower() in ("-inf", "-infinity") else (
                float("inf") if str(raw_end).lower() in ("inf", "+inf", "infinity") else float(raw_end)
            )
            eng = TopologicalInfinityEngine(x_start, x_end)
            return 200, {"ok": True, "evaluation": eng.evaluate_diagnostics()}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/kernel/update-variable":
        var_name = str(body.get("name", "")).strip()
        new_value = body.get("value")
        token = str(body.get("token", "")).strip()
        actor = str(body.get("actor", "operator")).strip()
        if not var_name:
            return 400, {"ok": False, "error": "Variable name is required"}
        outcome = runtime.kernel.update_protected_variable(var_name, new_value, token, actor=actor)
        return 200, outcome

    if method == "POST" and path == "/api/py/kernel/record-update":
        wersja = str(body.get("wersja", "")).strip()
        typ = str(body.get("typ", "Kernel Update")).strip()
        opis = str(body.get("opis", "")).strip()
        token = str(body.get("token", "")).strip()
        if not runtime.kernel.verify_operator_token(token):
            runtime.kernel.record_audit("operator", "RECORD_UPDATE_DENIED", wersja or "unknown", "DENIED", "Invalid SVL_OPERATOR_TOKEN")
            return 403, {"ok": False, "error": "Autoryzacja odrzucona: wymagany prawidłowy SVL_OPERATOR_TOKEN (>=32 znaki)."}
        if not wersja or not opis:
            return 400, {"ok": False, "error": "Pola 'wersja' i 'opis' są wymagane."}
        entry = runtime.kernel.record_update(wersja, typ, opis, author="operator")
        return 200, {"ok": True, "entry": entry, "history": runtime.kernel.get_update_history(include_demo=False)}

    if method == "POST" and path == "/api/py/agents/connect":
        triggered_by = str(body.get("triggered_by", "operator"))
        report = await runtime.orchestrator.connect_my_ai(triggered_by=triggered_by)
        return 200, {"ok": True, "connection_report": report}

    if method == "GET" and path == "/api/py/agents/status":
        agents = runtime.orchestrator.refresh_states()
        memories = {
            name: runtime.orchestrator.get_agent_memories(name, limit=15)
            for name in CANONICAL_SVL_AGENTS
        }
        return 200, {
            "connected_at": runtime.orchestrator.connected_at,
            "last_sync_report": runtime.orchestrator.last_Sync_report,
            "agents": agents,
            "agent_logs": runtime.orchestrator.agent_logs,
            "agent_queues": runtime.orchestrator.agent_queues,
            "agent_memories": memories,
            "spherical_bus": runtime.bus.get_spherical_observability_snapshot(),
        }

    if method == "POST" and path == "/api/py/agents/task":
        sender = str(body.get("sender", "operator")).strip()
        target_agent = str(body.get("target_agent", "Alex")).strip()
        title = str(body.get("title", "")).strip()
        payload = str(body.get("payload", "")).strip()
        if not title:
            return 400, {"ok": False, "error": "Tytuł zadania jest wymagany."}
        try:
            res = await runtime.orchestrator.dispatch_agent_task(sender, target_agent, title, payload)
            return 200, {"ok": True, **res}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/memory":
        agent_name = str(body.get("agent", "Alex")).strip()
        content = str(body.get("content", "")).strip()
        kind = str(body.get("kind", "fact")).strip()
        if not content:
            return 400, {"ok": False, "error": "Treść pamięci jest wymagana."}
        mem = runtime.orchestrator.add_agent_memory(agent_name, content, kind=kind, source="operator")
        return 200, {"ok": True, "memory": mem}

    if method == "POST" and path == "/api/py/agents/config":
        agent_name = str(body.get("agent", "")).strip()
        patch = body.get("config") if isinstance(body.get("config"), dict) else body
        try:
            updated = runtime.orchestrator.update_agent_config(agent_name, patch)
            return 200, {"ok": True, "agent": agent_name, "config": updated}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/configure-all":
        patch = body.get("config") if isinstance(body.get("config"), dict) else None
        try:
            updated = runtime.orchestrator.configure_all_agents(patch)
            report = await runtime.orchestrator.connect_my_ai(triggered_by="configure_all_agents")
            return 200, {"ok": True, "configs": updated, "connection_report": report}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/hyperspace/compute":
        text = str(body.get("text", "SVL_SYSTEM_QUANTUM_WHEEL")).strip()
        omega = float(body.get("omega", 1.5))
        t_val = float(body.get("t", 1.0))
        hs = runtime.hyperspace.resolve_intent(text)
        wnlp = runtime.without_nlp.analyze_signal(text, omega=omega, t=t_val)
        return 200, {
            "ok": True,
            "binary_hyperspace": hs,
            "without_nlp_harmonic": wnlp,
        }

    if method == "POST" and path == "/api/py/ollama/config":
        new_host = str(body.get("ollama_host", "")).strip()
        try:
            ollama_status = runtime.set_ollama_host(new_host)
            return 200, {"ok": True, "ollama": ollama_status}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/ollama/pull":
        model_name = str(body.get("model", "llama3.2-vision:11b")).strip()
        return runtime.pull_ollama_model(model_name)

    if method == "GET" and path == "/api/py/ollama/pull-status":
        return 200, {"ok": True, "pull_state": runtime.ollama_pull_state, "ollama": runtime.probe_ollama_status()}

    if method == "POST" and path == "/api/py/python-repl":
        code = str(body.get("code", ""))
        res = runtime.execute_python_repl(code)
        return 200, res

    if method == "GET" and path == "/api/py/chat/conversations":
        return 200, {"ok": True, "conversations": runtime.kernel.list_conversations_with_messages()}

    if method == "POST" and path == "/api/py/chat/conversations/sync":
        threads = body.get("conversations") if isinstance(body.get("conversations"), list) else []
        merged = runtime.kernel.sync_conversations(threads)
        return 200, {"ok": True, "conversations": merged}

    if method == "POST" and path == "/api/py/chat/conversations/message":
        cid = str(body.get("conversation_id", "")).strip()
        title = str(body.get("title", "Sesja SVL Python OS")).strip()
        model = str(body.get("model", "svl-hybrid-router")).strip()
        msg = body.get("message") if isinstance(body.get("message"), dict) else {}
        if not cid or not msg:
            return 400, {"ok": False, "error": "conversation_id and message are required"}
        saved = runtime.kernel.save_chat_message(cid, title, model, msg)
        return 200, {**saved, "conversations": runtime.kernel.list_conversations_with_messages()}

    if method == "POST" and path == "/api/py/chat/conversations/delete":
        cid = str(body.get("conversation_id", "")).strip()
        if not cid:
            return 400, {"ok": False, "error": "conversation_id is required"}
        deleted = runtime.kernel.delete_conversation(cid)
        return 200, {**deleted, "conversations": runtime.kernel.list_conversations_with_messages()}

    if method == "POST" and path == "/api/py/system/sync":
        # Full cross-subsystem synchronization: ensure all 4 workers alive, reload configs, probe Ollama/Codex, merge chat
        client_threads = body.get("conversations") if isinstance(body.get("conversations"), list) else []
        if client_threads:
            runtime.kernel.sync_conversations(client_threads)
        # Ensure all 4 workers are connected if any stopped
        alive_count = sum(1 for p in runtime.orchestrator.processes.values() if p.is_alive())
        sync_report = None
        if alive_count < len(CANONICAL_SVL_AGENTS):
            sync_report = await runtime.orchestrator.connect_my_ai(triggered_by="system_full_sync")
        agents = runtime.orchestrator.refresh_states()
        await runtime.bus.publish(
            topic="svl.system.synchronized",
            source=str(body.get("triggered_by", "operator_sync")),
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={"agents_online": len([a for a in agents if a.get("status") == "ONLINE_LOCAL_WORKER"])},
        )
        runtime.kernel.record_audit("operator", "SYSTEM_FULL_SYNC", "all_subsystems", "OK", "Synchronized kernel, agents, Ollama, and SQLite chat history")
        return 200, {
            "ok": True,
            "synchronized_at": datetime.now(timezone.utc).isoformat(),
            "connection_report": sync_report or runtime.orchestrator.last_Sync_report,
            "health": {
                "status": "ONLINE",
                "system": runtime.kernel.sys_version.value,
                "operator": runtime.kernel.operator.value,
                "host": runtime.probe_host_environment(),
                "ollama": runtime.probe_ollama_status(),
                "codex": runtime.probe_codex_status(),
            },
            "agents": agents,
            "conversations": runtime.kernel.list_conversations_with_messages(),
        }

    return 404, {"ok": False, "error": f"Unknown endpoint: {method} {path}"}


# Optional FastAPI binding for Debian 13 host with fastapi + uvicorn installed
try:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    fastapi_app = FastAPI(title="SVL Python OS Backend", version="5.6.0")

    @fastapi_app.api_route("/{full_path:path}", methods=["GET", "POST"])
    async def _fastapi_dispatch(request: Request, full_path: str) -> JSONResponse:
        path = "/" + full_path.lstrip("/")
        query = dict(request.query_params)
        body: dict[str, Any] = {}
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:
                body = {}
        status, payload = await handle_api_request(request.method, path, query, body)
        return JSONResponse(status_code=status, content=payload)
except ImportError:
    fastapi_app = None


async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        if not request_line:
            writer.close()
            return
        parts = request_line.decode("utf-8", errors="replace").strip().split(" ")
        if len(parts) < 2:
            writer.close()
            return
        method, raw_target = parts[0].upper(), parts[1]
        parsed = urllib.parse.urlsplit(raw_target)
        path = parsed.path
        query = dict(urllib.parse.parse_qsl(parsed.query))

        content_length = 0
        while True:
            header_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not header_line or header_line in (b"\r\n", b"\n"):
                break
            h_str = header_line.decode("utf-8", errors="replace").strip()
            if h_str.lower().startswith("content-length:"):
                content_length = int(h_str.split(":", 1)[1].strip())

        body: dict[str, Any] = {}
        if content_length > 0:
            raw_body = await asyncio.wait_for(reader.readexactly(content_length), timeout=5.0)
            try:
                body = json.loads(raw_body.decode("utf-8", errors="replace"))
            except Exception:
                body = {}

        status, response_payload = await handle_api_request(method, path, query, body)
        resp_bytes = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")
        status_text = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found"}.get(status, "OK")
        headers = (
            f"HTTP/1.1 {status} {status_text}\r\n"
            f"Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(resp_bytes)}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("utf-8")
        writer.write(headers + resp_bytes)
        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    port = int(os.environ.get("SVL_PYTHON_PORT", "8085"))
    # Automatically inspect SVL_System, spawn all 4 agent worker PIDs, and load full configs on boot
    try:
        await runtime.orchestrator.connect_my_ai(triggered_by="system_boot_autoconnect")
    except Exception as exc:
        print(f"[SVL Python OS] Warning during boot autoconnect: {exc}", flush=True)
    server = await asyncio.start_server(_handle_client, "127.0.0.1", port)
    print(f"[SVL Python OS] Backend Kernel running on http://127.0.0.1:{port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
