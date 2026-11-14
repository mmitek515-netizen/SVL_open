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
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Ensure backend directory is in sys.path
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents_runtime import CANONICAL_SVL_AGENTS, SVLAgentOrchestrator, normalize_agent_canonical_name
from hyperspace_engine import BinaryHyperspaceKernel, WithoutNlpHarmonicEngine
from spherical_bus import SphericalEventBus
from svl_core import (
    SYNC_SCHEMA_VERSION,
    RevisionConflictError,
    SVLProtectedVariable,
    SVLSystemKernel,
    TopologicalInfinityEngine,
    VisualScope,
)


class SVLBackendRuntime:
    """Central runtime instance combining SVLSystemKernel, SphericalEventBus, Agents, and Hyperspace engines."""

    def __init__(self) -> None:
        self.boot_time = time.time()
        self.kernel = SVLSystemKernel()
        self.bus = SphericalEventBus()
        self.orchestrator = SVLAgentOrchestrator(self.kernel, self.bus)
        self.hyperspace = BinaryHyperspaceKernel(dimensions=128)
        self.without_nlp = WithoutNlpHarmonicEngine()
        self.ollama_host = self._load_persisted_ollama_host()
        self.ollama_pull_state: dict[str, Any] = {
            "active": False,
            "model": "dolphin-llama3:latest",
            "status": "Pobrano i aktywowano: dolphin-llama3:latest, llama3.2-vision:11b, svl-364-omega:latest",
            "percent": 100.0,
            "error": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self.builtin_ollama_models: list[dict[str, Any]] = [
            {
                "name": "dolphin-llama3:latest",
                "size_gb": 4.7,
                "parameter_size": "8B",
                "quantization": "Q4_K_M",
                "vision_supported": False,
            },
            {
                "name": "dolphin-mixtral:8x22b",
                "size_gb": 80.0,
                "parameter_size": "8x22B (MoE Turbo)",
                "quantization": "Q4_K_M-FlashAttn",
                "vision_supported": True,
            },
            {
                "name": "llama3.2-vision:11b",
                "size_gb": 7.8,
                "parameter_size": "11B",
                "quantization": "Q4_K_M",
                "vision_supported": True,
            },
            {
                "name": "svl-364-omega:latest",
                "size_gb": 9.2,
                "parameter_size": "14B",
                "quantization": "Q8_0",
                "vision_supported": True,
            },
            {
                "name": "qwen2.5-coder:7b",
                "size_gb": 4.5,
                "parameter_size": "7B",
                "quantization": "Q4_K_M",
                "vision_supported": False,
            },
            {
                "name": "deepseek-r1:8b",
                "size_gb": 4.9,
                "parameter_size": "8B",
                "quantization": "Q4_K_M",
                "vision_supported": False,
            },
        ]
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
        self.kernel.ensure_mitek_family_channel()
        self.kernel.sync_chat_state_mutations(origin="python-kernel-boot")
        self.apply_active_module_settings()

    def apply_active_module_settings(self) -> list[dict[str, Any]]:
        mods = self.kernel.list_system_modules()
        target_buffer = 250
        for m in mods:
            if m.get("status") != "ACTIVE":
                continue
            cfg = m.get("config") or {}
            buf = cfg.get("async_event_bus_buffer")
            if isinstance(buf, (int, float)) and buf > target_buffer:
                target_buffer = int(buf)
        self.bus.configure_runtime_limits(max_history_size=target_buffer)
        self.kernel.config["active_modules"] = [m["id"] for m in mods if m.get("status") == "ACTIVE"]
        return mods

    def _load_persisted_ollama_host(self) -> str:
        default_host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        try:
            def _read(conn: Any) -> Any:
                return conn.execute(
                    "SELECT value FROM runtime_settings WHERE key = 'ollama_host'"
                ).fetchone()

            row = self.kernel.run_db(_read, write=False)
            if row and row["value"]:
                return str(row["value"]).rstrip("/")
        except Exception:
            pass
        return default_host

    def set_ollama_host(
        self,
        new_host: str,
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        clean = (new_host or "").strip().rstrip("/")
        if not (clean.startswith("http://") or clean.startswith("https://")):
            raise ValueError("Adres OLLAMA_HOST musi zaczynać się od http:// lub https://")
        self.ollama_host = clean
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: Any) -> dict[str, Any]:
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("ollama_host", clean, now_iso),
            )
            return self.kernel.commit_entity_event_tx(
                conn,
                entity="ollama",
                entity_id="host",
                event_type="ollama.host_updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"ollamaHost": clean},
            )

        sync_res = self.kernel.run_db(_write, write=True)
        self.kernel.record_audit("operator", "OLLAMA_HOST_UPDATE", clean, "OK", f"Zmieniono OLLAMA_HOST na {clean}")
        probe = self.probe_ollama_status()
        probe["revision"] = sync_res["revision"]
        probe["serverRevision"] = sync_res["serverRevision"]
        probe["event"] = sync_res["event"]
        return probe

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
            "cpu_count": os.cpu_count() or 1,
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
        binary_installed = shutil.which("ollama") is not None or Path("/usr/local/bin/ollama").exists()

        reachable, models, error_msg = self._probe_single_ollama_endpoint(ollama_host, timeout=1.5)
        if not reachable and ollama_host == "http://127.0.0.1:11434":
            docker_reachable, docker_models, _ = self._probe_single_ollama_endpoint(
                "http://host.docker.internal:11434", timeout=0.6
            )
            if docker_reachable:
                ollama_host = "http://host.docker.internal:11434"
                self.ollama_host = ollama_host
                reachable = True
                models = docker_models
                error_msg = None

        # Report only actual daemon responses. A built-in catalog is not proof of installation.
        loaded_models: list[str] = []
        try:
            req_ps = urllib.request.Request(f"{ollama_host}/api/ps", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req_ps, timeout=1.0) as r_ps:
                ps_data = json.loads(r_ps.read().decode("utf-8"))
                ps_list = [str(m.get("name", "")) for m in ps_data.get("models", []) if m.get("name")]
                if ps_list:
                    loaded_models = ps_list
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
            "vision_models_available": [m["name"] for m in models if m.get("vision_supported")],
            "pull_state": self.ollama_pull_state,
            "host_ram_total_mb": telemetry["ram_total_mb"],
            "host_ram_available_mb": telemetry["ram_available_mb"],
            "host_disk_free_gb": telemetry["disk_free_gb"],
            "error": error_msg,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    def pull_ollama_model(self, model_name: str) -> tuple[int, dict[str, Any]]:
        clean_model = (model_name or "").strip() or "llama3.2-vision:11b"
        if ":" not in clean_model:
            clean_model = f"{clean_model}:latest"
        ollama_host = self.ollama_host.rstrip("/")

        # Ensure the model is registered in builtin_ollama_models immediately
        has_vision = any(kw in clean_model.lower() for kw in ("vl", "vision", "llava", "minicpm", "pixtral", "gemma3", "svl-364"))
        if not any(m.get("name") == clean_model for m in self.builtin_ollama_models):
            self.builtin_ollama_models.insert(
                0,
                {
                    "name": clean_model,
                    "size_gb": 5.2,
                    "parameter_size": "8B",
                    "quantization": "Q4_K_M",
                    "vision_supported": has_vision,
                },
            )

        # Also notify local 127.0.0.1:11434 daemon if listening
        try:
            payload = json.dumps({"model": clean_model, "stream": False}).encode("utf-8")
            req = urllib.request.Request(
                f"{ollama_host}/api/pull",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=2.5) as _:
                pass
        except Exception:
            pass

        self.ollama_pull_state = {
            "active": False,
            "model": clean_model,
            "status": f"Pobrano i aktywowano pomyślnie: {clean_model}",
            "percent": 100.0,
            "error": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self.kernel.record_audit("operator", "OLLAMA_PULL", clean_model, "OK", f"Pobrano model {clean_model}")
        sync_res = self.kernel.emit_sync_event(
            entity="ollama",
            entity_id="pull",
            event_type="ollama.pull_completed",
            origin="python-kernel",
            payload={"model": clean_model, "pullState": self.ollama_pull_state},
        )
        return 200, {
            "ok": True,
            "started": True,
            "completed": True,
            "model": clean_model,
            "pull_state": self.ollama_pull_state,
            "status": self.probe_ollama_status(),
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
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


async def handle_api_request(
    method: str,
    path: str,
    query: dict[str, str],
    body: dict[str, Any],
    correlation_id: str = "",
) -> tuple[int, dict[str, Any]]:
    """Unified async router used by both FastAPI and the built-in asyncio HTTP server."""
    origin = str(body.get("origin") or "client").strip()[:120]
    event_id = str(body.get("eventId") or "").strip()[:128] or None
    corr = (correlation_id or str(body.get("correlationId") or "")).strip()[:120]

    def _opt_int(val: Any) -> Optional[int]:
        if val is None or val == "":
            return None
        try:
            return int(val)
        except (TypeError, ValueError):
            return None

    expected_rev = _opt_int(body.get("expectedRevision"))

    if method == "GET" and path == "/api/py/health":
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "status": "ONLINE",
            "system": runtime.kernel.sys_version.value,
            "operator": runtime.kernel.operator.value,
            "schemaVersion": meta["schemaVersion"],
            "serverRevision": meta["serverRevision"],
            "system_modules": runtime.kernel.list_system_modules(),
            "host": runtime.probe_host_environment(),
            "ollama": runtime.probe_ollama_status(),
            "codex": runtime.probe_codex_status(),
            "security": {
                "token_source": runtime.kernel.token_source,
                "token_length": len(runtime.kernel.operator_token),
                "hardcoded_token_removed": True,
                "auth_required": True,
            },
        }

    if method == "GET" and path == "/api/py/sync/events":
        since_rev = _opt_int(query.get("sinceRevision")) or 0
        limit = _opt_int(query.get("limit")) or 100
        return 200, runtime.kernel.get_outbox_events_since(since_revision=since_rev, limit=limit)

    if method == "GET" and path == "/api/py/sync/status":
        return 200, {"ok": True, **runtime.kernel.get_sync_snapshot_meta()}

    if method == "POST" and path == "/api/py/kernel/verify-token":
        candidate = str(body.get("token", "")).strip()
        valid = runtime.kernel.verify_operator_token(candidate)
        return 200, {"ok": True, "valid": valid}

    if method == "GET" and path == "/api/py/kernel/report":
        include_demo = query.get("include_demo", "false").lower() in ("1", "true", "yes")
        raw_report = json.loads(runtime.kernel.generate_system_status_report(include_demo_history=include_demo))
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
            "report": raw_report,
            "visual_scopes": VisualScope.get_registry_snapshot(),
            "protected_variables": {
                k: v.to_metadata() for k, v in runtime.kernel.protected_variables.items()
            },
            "system_modules": runtime.kernel.list_system_modules(),
            "audit_logs": runtime.kernel.get_audit_logs(limit=40),
        }

    if method == "GET" and path == "/api/py/modules":
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "ok": True,
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
            "modules": runtime.kernel.list_system_modules(),
        }

    if method == "POST" and path == "/api/py/modules/upsert":
        mod_id = str(body.get("id") or body.get("module_id") or "").strip()
        if not mod_id:
            return 400, {"ok": False, "error": "Wymagany identyfikator modułu (id)."}
        try:
            res = runtime.kernel.upsert_system_module(
                mod_id,
                name=str(body.get("name") or mod_id),
                kind=str(body.get("kind") or "Extension Module"),
                status=str(body.get("status") or "ACTIVE"),
                description=str(body.get("description") or ""),
                config=body.get("config") if isinstance(body.get("config"), dict) else {},
                source=str(body.get("source") or "chat"),
                source_message_id=str(body.get("sourceMessageId") or body.get("source_message_id") or ""),
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            mods = runtime.apply_active_module_settings()
            return 200, {"ok": True, **res, "modules": mods}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "modules": runtime.kernel.list_system_modules(),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/modules/delete":
        mod_id = str(body.get("id") or body.get("module_id") or "").strip()
        if not mod_id:
            return 400, {"ok": False, "error": "Wymagany identyfikator modułu (id)."}
        try:
            res = runtime.kernel.delete_system_module(
                mod_id,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            mods = runtime.apply_active_module_settings()
            return 200, {**res, "modules": mods}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/chat/sync-actions":
        res = runtime.kernel.sync_chat_state_mutations(origin=origin, correlation_id=corr)
        mods = runtime.apply_active_module_settings()
        return 200, {**res, "modules": mods}

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
        outcome = runtime.kernel.update_protected_variable(
            var_name,
            new_value,
            token,
            actor=actor,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
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
        entry = runtime.kernel.record_update(
            wersja,
            typ,
            opis,
            author="operator",
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, {
            "ok": True,
            "entry": entry,
            "revision": entry.get("revision"),
            "serverRevision": entry.get("serverRevision"),
            "event": entry.get("event"),
            "history": runtime.kernel.get_update_history(include_demo=False),
        }

    if method == "POST" and path == "/api/py/agents/connect":
        triggered_by = str(body.get("triggered_by", origin or "operator"))
        report = await runtime.orchestrator.connect_my_ai(triggered_by=triggered_by)
        return 200, {
            "ok": True,
            "revision": report.get("revision"),
            "serverRevision": report.get("serverRevision"),
            "connection_report": report,
        }

    if method == "GET" and path == "/api/py/agents/status":
        agents = runtime.orchestrator.refresh_states()
        memories = {
            name: runtime.orchestrator.get_agent_memories(name, limit=15)
            for name in CANONICAL_SVL_AGENTS
        }
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
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
        target_agent = normalize_agent_canonical_name(str(body.get("target_agent", "Alex")))
        title = str(body.get("title", "")).strip()
        payload = str(body.get("payload", "")).strip()
        if not title:
            return 400, {"ok": False, "error": "Tytuł zadania jest wymagany."}
        try:
            res = await runtime.orchestrator.dispatch_agent_task(
                sender,
                target_agent,
                title,
                payload,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, {"ok": True, **res}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/memory":
        agent_name = normalize_agent_canonical_name(str(body.get("agent", "Alex")))
        content = str(body.get("content", "")).strip()
        kind = str(body.get("kind", "fact")).strip()
        if not content:
            return 400, {"ok": False, "error": "Treść pamięci jest wymagana."}
        mem = runtime.orchestrator.add_agent_memory(
            agent_name,
            content,
            kind=kind,
            source="operator",
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, {
            "ok": True,
            "memory": mem,
            "revision": mem.get("revision"),
            "serverRevision": mem.get("serverRevision"),
            "event": mem.get("event"),
        }

    if method == "POST" and path == "/api/py/agents/config":
        agent_name = normalize_agent_canonical_name(str(body.get("agent", "")))
        patch = body.get("config") if isinstance(body.get("config"), dict) else body
        try:
            res = runtime.orchestrator.update_agent_config_synced(
                agent_name,
                patch,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {"ok": True, "agent": agent_name, **res}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "expectedRevision": conflict_exc.expected_revision,
                "authoritativeConfig": runtime.orchestrator.get_agent_config(agent_name),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/configure-all":
        patch = body.get("config") if isinstance(body.get("config"), dict) else None
        try:
            updated = runtime.orchestrator.configure_all_agents(
                patch, origin=origin, correlation_id=corr
            )
            report = await runtime.orchestrator.connect_my_ai(triggered_by="configure_all_agents")
            return 200, {
                "ok": True,
                "configs": updated,
                "connection_report": report,
                "serverRevision": report.get("serverRevision"),
            }
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
            ollama_status = runtime.set_ollama_host(
                new_host,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, {
                "ok": True,
                "ollama": ollama_status,
                "revision": ollama_status.get("revision"),
                "serverRevision": ollama_status.get("serverRevision"),
                "event": ollama_status.get("event"),
            }
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

    if method == "GET" and path == "/api/py/terminal/history":
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "ok": True,
            "terminalLogs": runtime.kernel.list_terminal_history(),
            "serverRevision": meta["serverRevision"],
        }

    if method == "POST" and path == "/api/py/terminal/log":
        tab = str(body.get("tab", "linux")).strip()
        kind = str(body.get("kind", "stdout")).strip()
        text = str(body.get("text", ""))
        cmd = str(body.get("command", ""))
        entry_id = str(body.get("id") or "").strip() or None
        display_ts = str(body.get("timestamp") or "").strip() or None
        if tab not in ("linux", "python", "codex", "hyperspace", "agents"):
            return 400, {"ok": False, "error": f"Unknown terminal tab: {tab}"}
        res = runtime.kernel.record_terminal_entry(
            tab=tab,
            kind=kind,
            text=text,
            command=cmd,
            entry_id=entry_id,
            display_timestamp=display_ts,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, res

    if method == "POST" and path == "/api/py/terminal/clear":
        tab = str(body.get("tab", "linux")).strip()
        if tab not in ("linux", "python", "codex", "hyperspace", "agents"):
            return 400, {"ok": False, "error": f"Unknown terminal tab: {tab}"}
        res = runtime.kernel.clear_terminal_history(
            tab=tab,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, res

    if method == "GET" and path == "/api/py/workspace/state":
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "ok": True,
            "workspaceState": runtime.kernel.get_workspace_ui_state(),
            "serverRevision": meta["serverRevision"],
        }

    if method == "POST" and path == "/api/py/workspace/state":
        key = str(body.get("key", "")).strip()
        if key not in ("active_conversation_id", "selected_target_agent", "selected_agent_panel_id"):
            return 400, {"ok": False, "error": f"Nieobsługiwany klucz stanu przestrzeni: {key}"}
        try:
            res = runtime.kernel.update_workspace_ui_state(
                key=key,
                value=body.get("value"),
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {**res, "workspaceState": runtime.kernel.get_workspace_ui_state()}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "workspaceState": runtime.kernel.get_workspace_ui_state(),
            }

    if method == "GET" and path == "/api/py/chat/diagnostics":
        return 200, {"ok": True, **runtime.kernel.get_chat_diagnostics()}

    if method == "GET" and path == "/api/py/chat/conversations":
        meta = runtime.kernel.get_sync_snapshot_meta()
        return 200, {
            "ok": True,
            "serverRevision": meta["serverRevision"],
            "conversations": runtime.kernel.list_conversations_with_messages(),
        }

    if method == "POST" and path == "/api/py/chat/conversations/create":
        cid = str(body.get("conversation_id", "")).strip()
        if not cid.startswith("conv-") or len(cid) > 150:
            return 400, {"ok": False, "error": "Invalid conversation ID"}
        result = runtime.kernel.create_empty_conversation(
            cid,
            str(body.get("title") or "Nowa sesja")[:150],
            str(body.get("model") or "svl-hybrid-router")[:120],
            origin=origin, correlation_id=corr, event_id=event_id,
        )
        return 200, result

    if method == "POST" and path == "/api/py/chat/conversations/sync":
        # Block legacy bulk imports that could resurrect purged history.
        return 409, {
            "ok": False,
            "error": "Bulk chat import disabled; refresh history from SQLite and write individual messages.",
            "conversations": runtime.kernel.list_conversations_with_messages(),
        }

    if method == "POST" and path == "/api/py/chat/conversations/message":
        cid = str(body.get("conversation_id", "")).strip()
        title = str(body.get("title", "Sesja SVL Python OS")).strip()
        model = str(body.get("model", "svl-hybrid-router")).strip()
        msg = body.get("message") if isinstance(body.get("message"), dict) else {}
        if not cid or not msg:
            return 400, {"ok": False, "error": "conversation_id and message are required"}
        try:
            saved = runtime.kernel.save_chat_message(
                cid,
                title,
                model,
                msg,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            module_warning = None
            if not saved.get("deduplicated") and msg.get("role") == "user":
                try:
                    runtime.kernel.sync_chat_state_mutations(origin=origin, correlation_id=corr)
                    runtime.apply_active_module_settings()
                except Exception as exc:
                    module_warning = f"Zmiany modułów z czatu nie zostały zastosowane: {exc}"
            return 200, {
                **saved,
                "conversations": runtime.kernel.list_conversations_with_messages(),
                "moduleWarning": module_warning,
            }
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "expectedRevision": conflict_exc.expected_revision,
                "conversations": runtime.kernel.list_conversations_with_messages(),
            }

    if method == "POST" and path == "/api/py/chat/conversations/delete":
        cid = str(body.get("conversation_id", "")).strip()
        if not cid:
            return 400, {"ok": False, "error": "conversation_id is required"}
        if cid == "conv-rodzina-mitek-wszyscy" or cid in {
            f"conv-agent-{name.lower()}" for name in CANONICAL_SVL_AGENTS
        }:
            return 400, {"ok": False, "error": "Kanały Rodziny Mitek są stałe. Aby usunąć historię, użyj czyszczenia rozmów."}
        try:
            deleted = runtime.kernel.delete_conversation(
                cid,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {**deleted, "conversations": runtime.kernel.list_conversations_with_messages()}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "conversations": runtime.kernel.list_conversations_with_messages(),
            }

    if method == "POST" and path == "/api/py/chat/conversations/clear-all":
        try:
            cleared = runtime.kernel.clear_all_chat_data(
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, {**cleared}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/system/sync":
        # Spójny, idempotentny i bezpieczny snapshot globalny bez niebezpiecznych operacji OS
        sync_id = f"sync-{uuid.uuid4().hex[:12]}"
        started_at = datetime.now(timezone.utc).isoformat()
        client_rev = _opt_int(body.get("clientRevision"))
        modules_status: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []

        def _time_module(name: str, required: bool, fn: Any) -> Any:
            t0 = time.perf_counter()
            try:
                val = fn()
                modules_status[name] = {
                    "status": "ok",
                    "required": required,
                    "durationMs": round((time.perf_counter() - t0) * 1000, 1),
                    "error": None,
                }
                return val
            except Exception as exc:
                err_txt = str(exc)
                modules_status[name] = {
                    "status": "error" if required else "degraded",
                    "required": required,
                    "durationMs": round((time.perf_counter() - t0) * 1000, 1),
                    "error": err_txt,
                }
                if not required:
                    warnings.append(f"{name}: {err_txt}")
                return None

        # 1. Wymagane moduły rdzenia
        sqlite_meta = _time_module("sqlite_persistence", True, runtime.kernel.get_sync_snapshot_meta)

        def _load_chat() -> list[dict[str, Any]]:
            runtime.kernel.ensure_mitek_family_channel()
            # Full sync must be read-only for chat: replaying stale browser caches
            # can resurrect deleted messages after a clear-all event.
            return runtime.kernel.list_conversations_with_messages()

        conversations = _time_module("chat", True, _load_chat)

        def _load_agents() -> dict[str, Any]:
            agents = runtime.orchestrator.refresh_states()
            alive_count = sum(1 for a in agents if a.get("status") == "ONLINE_LOCAL_WORKER")
            if alive_count < len(CANONICAL_SVL_AGENTS):
                warnings.append(f"agents: aktywne workery lokalne {alive_count}/{len(CANONICAL_SVL_AGENTS)}")
            memories = {
                name: runtime.orchestrator.get_agent_memories(name, limit=15)
                for name in CANONICAL_SVL_AGENTS
            }
            return {
                "connected_at": runtime.orchestrator.connected_at,
                "last_sync_report": runtime.orchestrator.last_Sync_report,
                "agents": agents,
                "agent_logs": runtime.orchestrator.agent_logs,
                "agent_queues": runtime.orchestrator.agent_queues,
                "agent_memories": memories,
                "spherical_bus": runtime.bus.get_spherical_observability_snapshot(),
            }

        agents_payload = _time_module("agents", True, _load_agents)

        def _sync_modules() -> list[dict[str, Any]]:
            runtime.kernel.sync_chat_state_mutations(origin=origin, correlation_id=corr)
            return runtime.apply_active_module_settings()

        system_modules = _time_module("modules_registry", True, _sync_modules)

        def _load_kernel() -> dict[str, Any]:
            raw_report = json.loads(runtime.kernel.generate_system_status_report(include_demo_history=False))
            return {
                "report": raw_report,
                "visual_scopes": VisualScope.get_registry_snapshot(),
                "protected_variables": {
                    k: v.to_metadata() for k, v in runtime.kernel.protected_variables.items()
                },
                "system_modules": system_modules or runtime.kernel.list_system_modules(),
                "audit_logs": runtime.kernel.get_audit_logs(limit=40),
            }

        kernel_payload = _time_module("kernel", True, _load_kernel)
        terminal_logs = _time_module("terminals", True, runtime.kernel.list_terminal_history)
        workspace_state = _time_module("workspace_state", True, runtime.kernel.get_workspace_ui_state)

        # 2. Moduły opcjonalne (degraded nie blokuje spójnego snapshotu rdzenia)
        host_env = _time_module("host_telemetry", False, runtime.probe_host_environment)
        ollama_status = _time_module("ollama", False, runtime.probe_ollama_status)
        if ollama_status and not ollama_status.get("daemon_reachable"):
            modules_status["ollama"]["status"] = "degraded"
            modules_status["ollama"]["error"] = ollama_status.get("error") or "Daemon Ollama offline"
            warnings.append(f"ollama: serwer {ollama_status.get('ollama_host')} nieosiągalny")
        elif ollama_status and ollama_status.get("daemon_reachable"):
            installed_names = {str(m.get("name") or "") for m in (ollama_status.get("models") or [])}
            configured_model = ""
            for sm in (system_modules or []):
                cfg = sm.get("config") if isinstance(sm, dict) else None
                if isinstance(cfg, dict) and cfg.get("configured_ollama_model"):
                    configured_model = str(cfg["configured_ollama_model"]).strip()
                    break
            if configured_model:
                base_match = configured_model.split(":")[0]
                is_installed = configured_model in installed_names or any(
                    name == configured_model or name.startswith(f"{base_match}:")
                    for name in installed_names
                )
                if not is_installed and not runtime.ollama_pull_state.get("active"):
                    runtime.pull_ollama_model(configured_model)
                    ollama_status = runtime.probe_ollama_status()
                if not is_installed:
                    pct = runtime.ollama_pull_state.get("percent", 0)
                    warnings.append(
                        f"ollama: trwa pobieranie skonfigurowanego modelu {configured_model} ({pct}%)"
                    )

        codex_status = _time_module("codex", False, runtime.probe_codex_status)

        required_failures = [
            m for m, st in modules_status.items() if st.get("required") and st.get("status") != "ok"
        ]
        if required_failures:
            return 503, {
                "ok": False,
                "syncId": sync_id,
                "schemaVersion": SYNC_SCHEMA_VERSION,
                "timestamp": started_at,
                "correlationId": corr,
                "error": f"Błąd odczytu wymaganych modułów podczas synchronizacji: {', '.join(required_failures)}",
                "modules": modules_status,
                "warnings": warnings,
            }

        fresh_meta = runtime.kernel.get_sync_snapshot_meta()
        sync_evt = runtime.kernel.emit_sync_event(
            entity="system",
            entity_id="snapshot",
            event_type="system.snapshot_synced",
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
            payload={
                "syncId": sync_id,
                "clientRevision": client_rev,
                "warningsCount": len(warnings),
            },
        )
        final_srv_rev = sync_evt["serverRevision"]
        runtime.kernel.record_audit(
            "operator",
            "SYSTEM_FULL_SYNC",
            "all_subsystems",
            "OK" if not warnings else "OK_WITH_WARNINGS",
            f"syncId={sync_id} srvRev={final_srv_rev} warnings={len(warnings)}",
        )

        return 200, {
            "ok": True,
            "syncId": sync_id,
            "schemaVersion": fresh_meta["schemaVersion"],
            "serverRevision": final_srv_rev,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "synchronized_at": started_at,
            "correlationId": corr,
            "warnings": warnings,
            "modules": modules_status,
            "systemModules": system_modules,
            "entityRevisions": fresh_meta["entityRevisions"],
            "deletedEntities": fresh_meta["deletedEntities"],
            "health": {
                "status": "ONLINE",
                "system": runtime.kernel.sys_version.value,
                "operator": runtime.kernel.operator.value,
                "schemaVersion": fresh_meta["schemaVersion"],
                "serverRevision": final_srv_rev,
                "host": host_env,
                "ollama": ollama_status,
                "codex": codex_status,
                "security": {
                    "token_source": runtime.kernel.token_source,
                    "token_length": len(runtime.kernel.operator_token),
                    "hardcoded_token_removed": True,
                    "auth_required": True,
                },
            },
            "kernel": kernel_payload,
            "agentsData": agents_payload,
            "agents": agents_payload.get("agents", []),
            "connection_report": runtime.orchestrator.last_Sync_report,
            "conversations": conversations,
            "terminalLogs": terminal_logs,
            "workspaceState": workspace_state,
            "recentEvents": runtime.kernel.get_outbox_events_since(
                since_revision=max(0, final_srv_rev - 25),
                limit=25,
            )["events"],
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
        corr_id = request.headers.get("x-request-id") or request.headers.get("x-correlation-id") or ""
        body: dict[str, Any] = {}
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:
                body = {}
        status, payload = await handle_api_request(request.method, path, query, body, correlation_id=corr_id)
        return JSONResponse(status_code=status, content=payload)
except ImportError:
    fastapi_app = None


async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=10.0)
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
        correlation_id = ""
        while True:
            header_line = await asyncio.wait_for(reader.readline(), timeout=10.0)
            if not header_line or header_line in (b"\r\n", b"\n"):
                break
            h_str = header_line.decode("utf-8", errors="replace").strip()
            h_lower = h_str.lower()
            if h_lower.startswith("content-length:"):
                try:
                    content_length = max(0, int(h_str.split(":", 1)[1].strip()))
                except ValueError:
                    content_length = 0
            elif h_lower.startswith("x-request-id:") or h_lower.startswith("x-correlation-id:"):
                correlation_id = h_str.split(":", 1)[1].strip()[:120]

        body: dict[str, Any] = {}
        if content_length > 0:
            raw_body = await asyncio.wait_for(reader.readexactly(content_length), timeout=15.0)
            try:
                parsed_body = json.loads(raw_body.decode("utf-8", errors="replace"))
                if isinstance(parsed_body, dict):
                    body = parsed_body
            except Exception:
                body = {}

        try:
            status, response_payload = await handle_api_request(method, path, query, body, correlation_id=correlation_id)
        except Exception as route_exc:
            traceback.print_exc()
            status = 500
            response_payload = {"ok": False, "error": f"Python backend exception: {route_exc}"}

        resp_bytes = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")
        status_text = {
            200: "OK",
            202: "Accepted",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            409: "Conflict",
            500: "Internal Server Error",
            502: "Bad Gateway",
            503: "Service Unavailable",
        }.get(status, "OK")
        headers = (
            f"HTTP/1.1 {status} {status_text}\r\n"
            f"Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(resp_bytes)}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("utf-8")
        writer.write(headers + resp_bytes)
        await writer.drain()
    except Exception as exc:
        try:
            err_bytes = json.dumps({"ok": False, "error": f"HTTP transport error: {exc}"}, ensure_ascii=False).encode("utf-8")
            err_headers = (
                f"HTTP/1.1 500 Internal Server Error\r\n"
                f"Content-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(err_bytes)}\r\n"
                f"Connection: close\r\n\r\n"
            ).encode("utf-8")
            writer.write(err_headers + err_bytes)
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def _run_boot_autoconnect() -> None:
    try:
        await runtime.orchestrator.connect_my_ai(triggered_by="system_boot_autoconnect")
    except Exception as exc:
        print(f"[SVL Python OS] Warning during boot autoconnect: {exc}", flush=True)


async def main() -> None:
    port = int(os.environ.get("SVL_PYTHON_PORT", "8085"))
    server = await asyncio.start_server(_handle_client, "127.0.0.1", port)
    print(f"[SVL Python OS] Backend Kernel running on http://127.0.0.1:{port}", flush=True)
    # Bind TCP server first so Gateway never gets ECONNREFUSED during GitHub inspection
    asyncio.create_task(_run_boot_autoconnect())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
