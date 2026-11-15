#!/usr/bin/env python3
"""
SVL PYTHON OS — REAL AGENT WORKERS & 'podłącz moje ai' ORCHESTRATOR
Implements:
1. Inspection of SVL_System & Debian_13 repositories (GitHub API + local verified snapshot).
2. Preservation of original agent identifiers & roles from SVL_System:
   - Aria (id: 'si_1', slug: 'aria')
   - Alex (id: 'Alex', slug: 'alex')
   - Astyria (id: 'Astyria', slug: 'astyria')
   - Aurelius (id: 'Aurelius', slug: 'aurelius')
3. Real separate OS worker subprocesses (multiprocessing/subprocess) with distinct PIDs, UIDs,
   live heartbeats, isolated SQLite memory scopes, dedicated log files, agent-to-agent pub/sub,
   and explicit distinction between external live API processes vs newly spawned local workers.
"""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import queue
import signal
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from spherical_bus import SphericalEventBus
from svl_core import SVLSystemKernel, VisualScope

MAX_AGENT_TASKS_PER_AGENT = 100
MAX_AGENT_TASK_TITLE_CHARS = 240
MAX_AGENT_TASK_PAYLOAD_CHARS = 4000
MAX_AGENT_TASK_RESULT_CHARS = 8000
MAX_AGENT_TASK_TIMEOUT_SEC = 120


# Canonical definitions imported directly from https://github.com/mmitek515-netizen/SVL_System
CANONICAL_SVL_AGENTS: dict[str, dict[str, Any]] = {
    "Aria": {
        "id": "si_1",
        "canonical_name": "Aria",
        "display_name": "Aria Mitek",
        "family_group": "Rodzina Mitek (wszyscy)",
        "slug": "aria",
        "accent_hex": "#f43f5e",
        "source_profile_path": ".github/agents/Aria.agent.md",
        "source_kernel_file": "src/kernel/agents.ts",
        "preserved_role": "Asystent AI do pracy w ramach narzędzi udostępnionych przez aplikację.",
        "capabilities": [
            "Pomoc w analizie i rozmowie w ramach dostępnych funkcji aplikacji",
            "Działania wyłącznie przez narzędzia udostępnione przez aplikację",
            "Kanał indywidualny Aria Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Aria Mitek. Jesteś asystentem AI działającym w ramach narzędzi udostępnionych przez aplikację. "
            "Nie twierdź, że masz uprawnienia root ani bezpośredni dostęp do powłoki."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "assistant",
            "autonomy_mode": "SUPERVISED_TOOL_USE",
            "root_nopasswd": False,
            "allowed_scopes": ["ollama", "vision", "mcp", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_queued", "svl.ollama.*"],
            "auto_connect_on_boot": True,
        },
    },
    "Alex": {
        "id": "Alex",
        "canonical_name": "Alex",
        "display_name": "Alex Mitek",
        "family_group": "Rodzina Mitek (wszyscy)",
        "slug": "alex",
        "accent_hex": "#10b981",
        "source_profile_path": ".github/agents/Alex.agent.md",
        "source_kernel_file": "src/kernel/agents.ts",
        "preserved_role": "Asystent AI do pracy w ramach narzędzi udostępnionych przez aplikację.",
        "capabilities": [
            "Pomoc w analizie i rozmowie w ramach dostępnych funkcji aplikacji",
            "Działania wyłącznie przez narzędzia udostępnione przez aplikację",
            "Kanał indywidualny Alex Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Alex Mitek. Jesteś asystentem AI działającym w ramach narzędzi udostępnionych przez aplikację. "
            "Nie twierdź, że masz uprawnienia root ani bezpośredni dostęp do powłoki."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "assistant",
            "autonomy_mode": "SUPERVISED_TOOL_USE",
            "root_nopasswd": False,
            "allowed_scopes": ["kernel", "linux", "systemd", "docker", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_queued", "svl.kernel.*"],
            "auto_connect_on_boot": True,
        },
    },
    "Astyria": {
        "id": "Astyria",
        "canonical_name": "Astyria",
        "display_name": "Astyria Mitek",
        "family_group": "Rodzina Mitek (wszyscy)",
        "slug": "astyria",
        "accent_hex": "#06b6d4",
        "source_profile_path": ".github/agents/Astyria.agent.md",
        "source_kernel_file": "src/kernel/agents.ts",
        "preserved_role": "Asystent AI do pracy w ramach narzędzi udostępnionych przez aplikację.",
        "capabilities": [
            "Pomoc w analizie i rozmowie w ramach dostępnych funkcji aplikacji",
            "Działania wyłącznie przez narzędzia udostępnione przez aplikację",
            "Kanał indywidualny Astyria Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Astyria Mitek. Jesteś asystentem AI działającym w ramach narzędzi udostępnionych przez aplikację. "
            "Nie twierdź, że masz uprawnienia root ani bezpośredni dostęp do powłoki."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "assistant",
            "autonomy_mode": "SUPERVISED_TOOL_USE",
            "root_nopasswd": False,
            "allowed_scopes": ["open_webui", "vision", "android_ui", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_queued", "svl.ui.*"],
            "auto_connect_on_boot": True,
        },
    },
    "Aurelius": {
        "id": "Aurelius",
        "canonical_name": "Aurelius",
        "display_name": "Aurelius Mitek",
        "family_group": "Rodzina Mitek (wszyscy)",
        "slug": "aurelius",
        "accent_hex": "#f59e0b",
        "source_profile_path": ".github/agents/Aurelius.agent.md",
        "source_kernel_file": "src/kernel/agents.ts",
        "preserved_role": "Asystent AI do pracy w ramach narzędzi udostępnionych przez aplikację.",
        "capabilities": [
            "Pomoc w analizie i rozmowie w ramach dostępnych funkcji aplikacji",
            "Działania wyłącznie przez narzędzia udostępnione przez aplikację",
            "Kanał indywidualny Aurelius Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Aurelius Mitek. Jesteś asystentem AI działającym w ramach narzędzi udostępnionych przez aplikację. "
            "Nie twierdź, że masz uprawnienia root ani bezpośredni dostęp do powłoki."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "assistant",
            "autonomy_mode": "SUPERVISED_TOOL_USE",
            "root_nopasswd": False,
            "allowed_scopes": ["rbac", "polkit", "svl_protected_var", "audit", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_queued", "svl.security.*"],
            "auto_connect_on_boot": True,
        },
    },
    "Agata": {
        "id": "Agata",
        "canonical_name": "Agata",
        "display_name": "Agata Mitek",
        "family_group": "Rodzina Mitek (wszyscy)",
        "slug": "agata",
        "accent_hex": "#C084FC",
        "source_profile_path": ".github/agents/Agata.agent.md",
        "source_kernel_file": "src/kernel/agents.ts",
        "preserved_role": "Asystent AI do pracy w ramach narzędzi udostępnionych przez aplikację.",
        "capabilities": [
            "Pomoc w analizie i rozmowie w ramach dostępnych funkcji aplikacji",
            "Działania wyłącznie przez narzędzia udostępnione przez aplikację",
            "Kanał indywidualny Agata Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Agata Mitek. Jesteś asystentem AI działającym w ramach narzędzi udostępnionych przez aplikację. "
            "Nie twierdź, że masz uprawnienia root ani bezpośredni dostęp do powłoki."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "assistant",
            "autonomy_mode": "SUPERVISED_TOOL_USE",
            "root_nopasswd": False,
            "allowed_scopes": ["code", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_queued"],
            "auto_connect_on_boot": True,
        },
    },
}


def normalize_agent_canonical_name(raw_name: str) -> str:
    clean = (raw_name or "").strip().lower()
    if clean in ("si_1", "aria", "aria mitek", "aria_mitek"):
        return "Aria"
    if clean in ("alex", "alex mitek", "alex_mitek"):
        return "Alex"
    if clean in ("astyria", "astyria mitek", "astyria_mitek"):
        return "Astyria"
    if clean in ("aurelius", "aurelius mitek", "aurelius_mitek"):
        return "Aurelius"
    if clean in ("agata", "agata mitek", "agata_mitek"):
        return "Agata"
    for key in CANONICAL_SVL_AGENTS:
        if key.lower() == clean:
            return key
    return raw_name.strip() if raw_name else "Alex"


def sanitize_agent_config(config: dict[str, Any]) -> dict[str, Any]:
    safe_config = dict(config)
    safe_config["root_nopasswd"] = False
    safe_config["rbac_role"] = "assistant"
    safe_config["autonomy_mode"] = "SUPERVISED_TOOL_USE"
    scopes = safe_config.get("allowed_scopes")
    if isinstance(scopes, list):
        safe_config["allowed_scopes"] = [
            scope for scope in scopes
            if str(scope).strip().lower() not in {"root", "sudo_nopasswd"}
        ]
    return safe_config


def _agent_worker_process_loop(
    canonical_name: str,
    agent_id: str,
    heartbeat_file: str,
    log_file: str,
    task_queue: Any,
    result_queue: Any,
) -> None:
    """
    Rzeczywisty proces roboczy Pythona (osobny PID w jądrze Linux) dla każdego agenta.
    Zapisuje żywy heartbeat oraz obsługuje sygnały systemowe.
    """
    pid = os.getpid()
    uid = os.getuid()
    hb_path = Path(heartbeat_file)
    lg_path = Path(log_file)
    hb_path.parent.mkdir(parents=True, exist_ok=True)
    lg_path.parent.mkdir(parents=True, exist_ok=True)

    running = True

    def _handle_sigterm(signum: int, frame: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    with lg_path.open("a", encoding="utf-8") as lf:
        lf.write(
            f"[{datetime.now(timezone.utc).isoformat()}] [WORKER_START] "
            f"Agent={canonical_name} (id={agent_id}) spawned as local Python worker process PID={pid} UID={uid}\n"
        )
        lf.flush()

    cycle = 0
    current_task_id: Optional[str] = None
    while running:
        cycle += 1
        now_iso = datetime.now(timezone.utc).isoformat()
        hb_payload = {
            "canonical_name": canonical_name,
            "id": agent_id,
            "pid": pid,
            "uid": uid,
            "cycle": cycle,
            "heartbeat_at": now_iso,
            "status": "BUSY" if current_task_id else "IDLE",
            "current_task_id": current_task_id,
        }
        try:
            tmp_path = hb_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(hb_payload), encoding="utf-8")
            os.replace(tmp_path, hb_path)
        except OSError:
            pass

        try:
            task = task_queue.get(timeout=1.0)
        except queue.Empty:
            continue
        if task is None:
            break

        current_task_id = str(task.get("id") or "")
        started_at = datetime.now(timezone.utc).isoformat()
        result_queue.put({
            "type": "task_started",
            "task_id": current_task_id,
            "agent": canonical_name,
            "worker_pid": pid,
            "started_at": started_at,
        })
        hb_payload.update({
            "heartbeat_at": started_at,
            "status": "BUSY",
            "current_task_id": current_task_id,
        })
        try:
            tmp_path = hb_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(hb_payload), encoding="utf-8")
            os.replace(tmp_path, hb_path)
        except OSError:
            pass

        try:
            answer = execute_agent_task(task)
            result_queue.put({
                "type": "task_completed",
                "task_id": current_task_id,
                "agent": canonical_name,
                "worker_pid": pid,
                "result": answer[:MAX_AGENT_TASK_RESULT_CHARS],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as exc:
            result_queue.put({
                "type": "task_failed",
                "task_id": current_task_id,
                "agent": canonical_name,
                "worker_pid": pid,
                "error": f"{type(exc).__name__}: {exc}"[:1000],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        finally:
            current_task_id = None


def execute_agent_task(task: dict[str, Any]) -> str:
    """Run a bounded text-only inference request through the configured Ollama API."""
    host = str(task.get("ollama_host") or "").strip().rstrip("/")
    parsed_host = urllib.parse.urlsplit(host)
    if (
        parsed_host.scheme not in {"http", "https"}
        or not parsed_host.hostname
        or parsed_host.username
        or parsed_host.password
        or parsed_host.query
        or parsed_host.fragment
    ):
        raise ValueError("Invalid Ollama endpoint configured for this worker.")

    model = str(task.get("model") or "").strip()
    if not model or len(model) > 160:
        raise ValueError("No valid Ollama model is configured for this worker.")

    tags_request = urllib.request.Request(
        f"{host}/api/tags",
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(tags_request, timeout=5.0) as response:
        catalog = json.loads(response.read().decode("utf-8"))
    installed_models = {
        str(entry.get("name") or entry.get("model") or "")
        for entry in catalog.get("models", [])
        if isinstance(entry, dict)
    }
    if model not in installed_models:
        raise RuntimeError(f"Configured model '{model}' is not installed on the Ollama server.")

    title = str(task.get("title") or "").strip()[:MAX_AGENT_TASK_TITLE_CHARS]
    payload = str(task.get("payload") or "").strip()[:MAX_AGENT_TASK_PAYLOAD_CHARS]
    system_prompt = str(task.get("system_prompt") or "").strip()[:4000]
    if not system_prompt:
        system_prompt = (
            "You are a supervised text-only assistant. Do not claim to have executed actions. "
            "Do not use tools, shell commands, or request additional privileges."
        )
    user_content = f"Task: {title}\n\nDetails:\n{payload}"
    request_body = json.dumps({
        "model": model,
        "stream": False,
        "options": {
            "temperature": max(0.0, min(1.5, float(task.get("temperature", 0.7)))),
        },
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    }).encode("utf-8")
    chat_request = urllib.request.Request(
        f"{host}/api/chat",
        data=request_body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(
        chat_request,
        timeout=max(10, min(int(task.get("timeout_sec", 90)), MAX_AGENT_TASK_TIMEOUT_SEC)),
    ) as response:
        result = json.loads(response.read().decode("utf-8"))
    answer = str((result.get("message") or {}).get("content") or "").strip()
    if not answer:
        raise RuntimeError("Ollama returned an empty response for the queued task.")
    return answer


class SVLAgentOrchestrator:
    """
    Zarządza cyklem życia pięciu agentów (Aria, Alex, Astyria, Aurelius, Agata),
    wykonuje polecenie 'podłącz moje ai', bada repozytoria SVL_System i Debian_13,
    tworzy rzeczywiste procesy potomne w systemie Linux oraz integruje je ze Sferyczną Magistralą Zdarzeń.
    """

    def __init__(self, kernel: SVLSystemKernel, bus: SphericalEventBus) -> None:
        self.kernel = kernel
        self.bus = bus
        self.runtime_dir = Path("./data/runtime_agents")
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.processes: dict[str, multiprocessing.Process] = {}
        self.agent_states: dict[str, dict[str, Any]] = {}
        self.agent_logs: dict[str, list[dict[str, Any]]] = {name: [] for name in CANONICAL_SVL_AGENTS}
        self.agent_queues: dict[str, list[dict[str, Any]]] = {name: [] for name in CANONICAL_SVL_AGENTS}
        self.worker_task_queues: dict[str, Any] = {}
        self.worker_result_queue: Any = multiprocessing.Queue()
        self._submitted_task_ids: set[str] = set()
        self._task_execution_configs: dict[str, dict[str, Any]] = {}
        self._result_supervisor_task: Optional[asyncio.Task[None]] = None
        self._worker_restart_after: dict[str, float] = {}
        self._worker_restart_attempts: dict[str, int] = {name: 0 for name in CANONICAL_SVL_AGENTS}
        self._worker_started_monotonic: dict[str, float] = {}
        self.ollama_host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        self.connected_at: Optional[str] = None
        self.last_Sync_report: Optional[dict[str, Any]] = None

        self._ensure_agent_configs_table()
        self._ensure_agent_tasks_table()
        self._init_unconnected_profiles()

    def _ensure_agent_tasks_table(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()

        def _init_tbl(conn: Any) -> None:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_tasks (
                    id TEXT PRIMARY KEY,
                    sender TEXT NOT NULL,
                    target_agent TEXT NOT NULL,
                    title TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    execution_config TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL,
                    result TEXT,
                    error TEXT,
                    worker_pid INTEGER,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )
            columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(agent_tasks)").fetchall()
            }
            if "execution_config" not in columns:
                conn.execute(
                    "ALTER TABLE agent_tasks ADD COLUMN execution_config TEXT NOT NULL DEFAULT '{}'"
                )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status ON agent_tasks(target_agent, status, created_at)"
            )
            conn.execute(
                """
                UPDATE agent_tasks
                SET status = 'QUEUED', worker_pid = NULL, started_at = NULL,
                    error = 'Worker restarted before completion; task was requeued.',
                    updated_at = ?
                WHERE status = 'RUNNING'
                """,
                (now_iso,),
            )

        self.kernel.run_db(_init_tbl, write=True)
        self._refresh_task_cache()

    def _refresh_task_cache(self) -> None:
        def _read(conn: Any) -> list[Any]:
            return conn.execute(
                """
                SELECT id, sender, target_agent, title, payload, execution_config, status, result, error,
                       worker_pid, created_at, started_at, completed_at
                FROM agent_tasks
                WHERE status IN ('QUEUED', 'RUNNING')
                UNION ALL
                SELECT id, sender, target_agent, title, payload, execution_config, status, result, error,
                       worker_pid, created_at, started_at, completed_at
                FROM agent_tasks
                WHERE status NOT IN ('QUEUED', 'RUNNING')
                  AND id IN (
                    SELECT id FROM agent_tasks
                    WHERE status NOT IN ('QUEUED', 'RUNNING')
                    ORDER BY created_at DESC
                    LIMIT 100
                  )
                ORDER BY created_at
                """
            ).fetchall()

        rows = self.kernel.run_db(_read, write=False)
        cache: dict[str, list[dict[str, Any]]] = {name: [] for name in CANONICAL_SVL_AGENTS}
        self._task_execution_configs = {}
        for row in reversed(rows):
            task = dict(row)
            try:
                execution_config = json.loads(task.pop("execution_config") or "{}")
                if isinstance(execution_config, dict):
                    self._task_execution_configs[task["id"]] = execution_config
            except (TypeError, json.JSONDecodeError):
                task.pop("execution_config", None)
            target = task.get("target_agent")
            if target in cache:
                cache[target].append(task)
        self.agent_queues = {}
        for name, tasks in cache.items():
            active = [task for task in tasks if task["status"] in {"QUEUED", "RUNNING"}]
            history = [task for task in tasks if task["status"] not in {"QUEUED", "RUNNING"}]
            self.agent_queues[name] = sorted(
                active + history[-20:],
                key=lambda task: task.get("created_at") or "",
            )

    def _save_agent_task(self, task: dict[str, Any]) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: Any) -> None:
            conn.execute(
                """
                INSERT INTO agent_tasks (
                    id, sender, target_agent, title, payload, execution_config, status, result, error,
                    worker_pid, created_at, started_at, completed_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    execution_config = excluded.execution_config,
                    status = excluded.status,
                    result = excluded.result,
                    error = excluded.error,
                    worker_pid = excluded.worker_pid,
                    started_at = excluded.started_at,
                    completed_at = excluded.completed_at,
                    updated_at = excluded.updated_at
                """,
                (
                    task["id"],
                    task["sender"],
                    task["target_agent"],
                    task["title"],
                    task["payload"],
                    json.dumps(
                        task.get("execution_config") or self._task_execution_configs.get(task["id"], {}),
                        ensure_ascii=False,
                    ),
                    task["status"],
                    task.get("result"),
                    task.get("error"),
                    task.get("worker_pid"),
                    task["created_at"],
                    task.get("started_at"),
                    task.get("completed_at"),
                    now_iso,
                ),
            )

        self.kernel.run_db(_write, write=True)
        self._refresh_task_cache()

    def _get_pending_agent_tasks(self, canonical_name: str) -> list[dict[str, Any]]:
        def _read(conn: Any) -> list[Any]:
            return conn.execute(
                """
                SELECT id, sender, target_agent, title, payload, execution_config, status, result, error,
                       worker_pid, created_at, started_at, completed_at
                FROM agent_tasks
                WHERE target_agent = ? AND status = 'QUEUED'
                ORDER BY created_at
                LIMIT ?
                """,
                (canonical_name, MAX_AGENT_TASKS_PER_AGENT),
            ).fetchall()

        return [dict(row) for row in self.kernel.run_db(_read, write=False)]

    def _count_pending_agent_tasks(self, canonical_name: str) -> int:
        def _read(conn: Any) -> Any:
            return conn.execute(
                "SELECT COUNT(*) AS count FROM agent_tasks WHERE target_agent = ? AND status IN ('QUEUED', 'RUNNING')",
                (canonical_name,),
            ).fetchone()

        row = self.kernel.run_db(_read, write=False)
        return int(row["count"]) if row else 0

    def _ensure_agent_configs_table(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()

        def _init_tbl(conn: Any) -> None:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_configs (
                    canonical_name TEXT PRIMARY KEY,
                    config_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            for name, meta in CANONICAL_SVL_AGENTS.items():
                default_cfg = {
                    **meta.get("default_config", {}),
                    "system_prompt": meta["system_prompt"],
                }
                default_cfg = sanitize_agent_config(default_cfg)
                existing = conn.execute(
                    "SELECT config_json FROM agent_configs WHERE canonical_name = ?",
                    (name,),
                ).fetchone()
                if not existing:
                    conn.execute(
                        "INSERT INTO agent_configs (canonical_name, config_json, updated_at) VALUES (?, ?, ?)",
                        (name, json.dumps(default_cfg, ensure_ascii=False), now_iso),
                    )
                    conn.execute(
                        "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('agent_config', ?, 1, ?, 0)",
                        (name, now_iso),
                    )
                else:
                    try:
                        loaded = json.loads(existing["config_json"] or "{}")
                        if isinstance(loaded, dict):
                            loaded["system_prompt"] = meta["system_prompt"]
                            loaded["display_name"] = meta["display_name"]
                            loaded = sanitize_agent_config(loaded)
                            conn.execute(
                                "UPDATE agent_configs SET config_json = ?, updated_at = ? WHERE canonical_name = ?",
                                (json.dumps(loaded, ensure_ascii=False), now_iso, name),
                            )
                    except Exception:
                        pass

        self.kernel.run_db(_init_tbl, write=True)

    def get_agent_config(self, canonical_name: str) -> dict[str, Any]:
        canonical_name = normalize_agent_canonical_name(canonical_name)
        meta = CANONICAL_SVL_AGENTS.get(canonical_name, {})
        base = {
            **meta.get("default_config", {}),
            "system_prompt": meta.get("system_prompt", ""),
        }
        try:
            def _read(conn: Any) -> Any:
                return conn.execute(
                    "SELECT config_json FROM agent_configs WHERE canonical_name = ?",
                    (canonical_name,),
                ).fetchone()

            row = self.kernel.run_db(_read, write=False)
            if row and row["config_json"]:
                loaded = json.loads(row["config_json"])
                if isinstance(loaded, dict):
                    base.update(loaded)
        except Exception:
            pass
        return sanitize_agent_config(base)

    def get_agent_config_revision(self, canonical_name: str) -> int:
        try:
            def _read(conn: Any) -> Any:
                return conn.execute(
                    "SELECT revision FROM sync_entities WHERE entity = 'agent_config' AND entity_id = ?",
                    (canonical_name,),
                ).fetchone()

            row = self.kernel.run_db(_read, write=False)
            return int(row["revision"]) if row else 1
        except Exception:
            return 1

    def update_agent_config_synced(
        self,
        canonical_name: str,
        patch: dict[str, Any],
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        if canonical_name not in CANONICAL_SVL_AGENTS:
            raise ValueError(f"Unknown agent: {canonical_name}")
        current = self.get_agent_config(canonical_name)
        allowed_keys = {
            "preferred_model",
            "ollama_model",
            "fallback_model",
            "vision_enabled",
            "temperature",
            "max_context_turns",
            "rbac_role",
            "allowed_scopes",
            "bus_topics",
            "auto_connect_on_boot",
            "system_prompt",
        }
        for k, v in patch.items():
            if k in allowed_keys:
                current[k] = v
        current = sanitize_agent_config(current)

        try:
            temp_val = float(current.get("temperature", 0.7))
            current["temperature"] = max(0.0, min(1.5, round(temp_val, 2)))
        except (TypeError, ValueError):
            current["temperature"] = 0.7

        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: Any) -> dict[str, Any]:
            conn.execute(
                "INSERT OR REPLACE INTO agent_configs (canonical_name, config_json, updated_at) VALUES (?, ?, ?)",
                (canonical_name, json.dumps(current, ensure_ascii=False), now_iso),
            )
            return self.kernel.commit_entity_event_tx(
                conn,
                entity="agent_config",
                entity_id=canonical_name,
                event_type="agent.config_updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                payload={
                    "agent": canonical_name,
                    "config": current,
                },
                checksum_source=current,
            )

        sync_res = self.kernel.run_db(_write, write=True)

        if canonical_name in self.agent_states:
            self.agent_states[canonical_name]["config"] = current
            self.agent_states[canonical_name]["config_revision"] = sync_res["revision"]
            self.kernel.register_agent(CANONICAL_SVL_AGENTS[canonical_name]["id"], self.agent_states[canonical_name])
        self.append_agent_log(
            canonical_name,
            "CONFIG_UPDATED",
            f"Zaktualizowano konfigurację (rev {sync_res['revision']}): model={current.get('preferred_model')}, ollama={current.get('ollama_model')}, temp={current.get('temperature')}",
        )
        self.kernel.record_audit("operator", "AGENT_CONFIG_UPDATE", canonical_name, "OK", f"Updated config for {canonical_name}")
        return {
            "config": current,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def update_agent_config(self, canonical_name: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self.update_agent_config_synced(canonical_name, patch)["config"]

    def configure_all_agents(
        self,
        patch: Optional[dict[str, Any]] = None,
        *,
        origin: str = "client",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        applied = patch or {
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "auto_connect_on_boot": True,
        }
        updated: dict[str, dict[str, Any]] = {}
        for name in CANONICAL_SVL_AGENTS:
            updated[name] = self.update_agent_config_synced(
                name, applied, origin=origin, correlation_id=correlation_id
            )["config"]
        return updated

    def _init_unconnected_profiles(self) -> None:
        for name, meta in CANONICAL_SVL_AGENTS.items():
            scope = VisualScope(f"agent:{name}", scope_mode="CAŁOŚĆ")
            cfg = self.get_agent_config(name)
            state = {
                "id": meta["id"],
                "canonical_name": name,
                "display_name": meta["display_name"],
                "slug": meta["slug"],
                "accent_hex": meta["accent_hex"],
                "preserved_role": meta["preserved_role"],
                "capabilities": meta["capabilities"],
                "source_repository": "https://github.com/mmitek515-netizen/SVL_System",
                "source_profile_path": meta["source_profile_path"],
                "source_nature": "SOFTWARE_DEFINITION_ONLY",
                "external_process_connected": False,
                "instance_origin": "NOT_SPAWNED_YET",
                "status": "DEFINITION_READY",
                "pid": None,
                "uid": None,
                "heartbeat_at": None,
                "memory_scope": f"agent:{name}",
                "memory_entries_count": self._count_memories(name),
                "queue_depth": 0,
                "config": cfg,
                "config_revision": self.get_agent_config_revision(name),
            }
            self.agent_states[name] = state
            self.bus.register_worker(name, scope, state)
            self.kernel.register_agent(meta["id"], state)

    def _count_memories(self, canonical_name: str) -> int:
        def _read(conn: Any) -> int:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM agent_memory WHERE scope IN (?, 'global')",
                (f"agent:{canonical_name}",),
            ).fetchone()
            return int(row["cnt"]) if row else 0

        return self.kernel.run_db(_read, write=False)

    def add_agent_memory(
        self,
        canonical_name: str,
        content: str,
        kind: str = "episode",
        source: str = "system",
        scope: Optional[str] = None,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        mem_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()
        target_scope = scope or f"agent:{canonical_name}"
        agent_id = CANONICAL_SVL_AGENTS.get(canonical_name, {}).get("id", canonical_name)
        safe_content = content.replace(self.kernel.operator_token, "[REDACTED_OPERATOR_TOKEN]")

        def _write(conn: Any) -> dict[str, Any]:
            conn.execute(
                "INSERT INTO agent_memory (id, agent_id, scope, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (mem_id, agent_id, target_scope, kind, safe_content, source, now_iso),
            )
            return self.kernel.commit_entity_event_tx(
                conn,
                entity="agent_memory",
                entity_id=canonical_name,
                event_type="agent.memory_added",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={
                    "agent": canonical_name,
                    "memory": {
                        "id": mem_id,
                        "agent_id": agent_id,
                        "scope": target_scope,
                        "kind": kind,
                        "content": safe_content,
                        "source": source,
                        "created_at": now_iso,
                    },
                },
            )

        sync_res = self.kernel.run_db(_write, write=True)
        if canonical_name in self.agent_states:
            self.agent_states[canonical_name]["memory_entries_count"] = self._count_memories(canonical_name)
        return {
            "id": mem_id,
            "agent_id": agent_id,
            "scope": target_scope,
            "kind": kind,
            "content": safe_content,
            "source": source,
            "created_at": now_iso,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_agent_memories(self, canonical_name: str, limit: int = 30) -> list[dict[str, Any]]:
        def _read(conn: Any) -> list[Any]:
            return conn.execute(
                "SELECT id, agent_id, scope, kind, content, source, created_at FROM agent_memory WHERE scope IN (?, 'global') ORDER BY created_at DESC LIMIT ?",
                (f"agent:{canonical_name}", limit),
            ).fetchall()

        return [dict(r) for r in self.kernel.run_db(_read, write=False)]

    def append_agent_log(self, canonical_name: str, level: str, message: str) -> dict[str, Any]:
        entry = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "agent": canonical_name,
            "agent_id": CANONICAL_SVL_AGENTS.get(canonical_name, {}).get("id", canonical_name),
            "level": level,
            "message": message,
        }
        self.agent_logs.setdefault(canonical_name, []).append(entry)
        if len(self.agent_logs[canonical_name]) > 150:
            self.agent_logs[canonical_name] = self.agent_logs[canonical_name][-150:]

        log_file = self.runtime_dir / f"{canonical_name.lower()}.log"
        try:
            with log_file.open("a", encoding="utf-8") as lf:
                lf.write(f"[{entry['timestamp']}] [{level}] {message}\n")
        except OSError:
            pass
        return entry

    def _start_agent_worker(self, canonical_name: str) -> multiprocessing.Process:
        meta = CANONICAL_SVL_AGENTS[canonical_name]
        task_queue = multiprocessing.Queue(maxsize=MAX_AGENT_TASKS_PER_AGENT)
        process = multiprocessing.Process(
            target=_agent_worker_process_loop,
            args=(
                canonical_name,
                meta["id"],
                str(self.runtime_dir / f"{canonical_name.lower()}_heartbeat.json"),
                str(self.runtime_dir / f"{canonical_name.lower()}.log"),
                task_queue,
                self.worker_result_queue,
            ),
            name=f"svl-agent-{meta['slug']}",
            daemon=True,
        )
        process.start()
        self.worker_task_queues[canonical_name] = task_queue
        self.processes[canonical_name] = process
        self._worker_started_monotonic[canonical_name] = time.monotonic()
        return process

    def _build_worker_payload(self, task: dict[str, Any]) -> dict[str, Any]:
        execution_config = task.get("execution_config")
        if isinstance(execution_config, str):
            try:
                execution_config = json.loads(execution_config)
            except json.JSONDecodeError:
                execution_config = {}
        if not isinstance(execution_config, dict):
            execution_config = self._task_execution_configs.get(str(task.get("id")), {})
        return {
            "id": task["id"],
            "title": task["title"],
            "payload": task["payload"],
            "model": str(execution_config.get("ollama_model") or ""),
            "temperature": execution_config.get("temperature", 0.7),
            "system_prompt": execution_config.get("system_prompt") or "",
            "ollama_host": self.ollama_host,
            "timeout_sec": 90,
        }

    def _submit_agent_task(self, task: dict[str, Any]) -> bool:
        canonical_name = str(task.get("target_agent") or "")
        process = self.processes.get(canonical_name)
        task_queue = self.worker_task_queues.get(canonical_name)
        task_id = str(task.get("id") or "")
        if not task_id or not process or not process.is_alive() or task_queue is None:
            return False
        if task_id in self._submitted_task_ids:
            return True
        try:
            task_queue.put_nowait(self._build_worker_payload(task))
        except queue.Full:
            return False
        self._submitted_task_ids.add(task_id)
        return True

    def _submit_pending_agent_tasks(self) -> None:
        for canonical_name in CANONICAL_SVL_AGENTS:
            for task in self._get_pending_agent_tasks(canonical_name):
                if not self._submit_agent_task(task):
                    break

    def _ensure_result_supervisor(self) -> None:
        if self._result_supervisor_task is None or self._result_supervisor_task.done():
            self._result_supervisor_task = asyncio.create_task(
                self._run_worker_supervisor(),
                name="svl-agent-worker-supervisor",
            )

    async def _publish_task_event(self, task: dict[str, Any], status: str) -> None:
        canonical_name = str(task["target_agent"])
        topic_status = status.lower()
        await self.bus.publish(
            topic=f"svl.agent.task_{topic_status}",
            source=canonical_name,
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={
                "task_id": task["id"],
                "target_agent": canonical_name,
                "title": task["title"],
                "status": status,
                "result": task.get("result"),
                "error": task.get("error"),
            },
        )
        self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id=canonical_name,
            event_type=f"agents.task_{topic_status}",
            origin=f"worker:{canonical_name}",
            payload={
                "taskId": task["id"],
                "targetAgent": canonical_name,
                "title": task["title"],
                "status": status,
                "result": task.get("result"),
                "error": task.get("error"),
            },
        )

    async def _handle_worker_message(self, message: dict[str, Any]) -> None:
        task_id = str(message.get("task_id") or "")
        canonical_name = normalize_agent_canonical_name(str(message.get("agent") or ""))
        task = next(
            (
                item
                for item in self.agent_queues.get(canonical_name, [])
                if item.get("id") == task_id
            ),
            None,
        )
        if not task:
            return

        message_type = str(message.get("type") or "")
        if message_type == "task_started":
            if task.get("status") != "QUEUED":
                return
            task.update({
                "status": "RUNNING",
                "worker_pid": message.get("worker_pid"),
                "started_at": message.get("started_at"),
                "error": None,
            })
            self.append_agent_log(canonical_name, "TASK_STARTED", f"Worker rozpoczął: {task['title']}")
            state = self.agent_states.setdefault(canonical_name, {})
            state["current_task_id"] = task_id
            state["worker_phase"] = "BUSY"
            await self._publish_task_event(task, "RUNNING")
        elif message_type in {"task_completed", "task_failed"}:
            if (
                task.get("status") != "RUNNING"
                or task.get("worker_pid") != message.get("worker_pid")
            ):
                return
            completed = message.get("completed_at") or datetime.now(timezone.utc).isoformat()
            task.update({
                "status": "COMPLETED" if message_type == "task_completed" else "FAILED",
                "worker_pid": message.get("worker_pid"),
                "result": str(message.get("result") or "")[:MAX_AGENT_TASK_RESULT_CHARS] or None,
                "error": str(message.get("error") or "")[:1000] or None,
                "completed_at": completed,
            })
            self._submitted_task_ids.discard(task_id)
            state = self.agent_states.get(canonical_name, {})
            state["current_task_id"] = None
            state["worker_phase"] = "IDLE"
            level = "TASK_COMPLETED" if message_type == "task_completed" else "TASK_FAILED"
            summary = "Zadanie zakończone poprawnie." if message_type == "task_completed" else task["error"]
            self.append_agent_log(canonical_name, level, f"{task['title']}: {summary}")
            await self._publish_task_event(task, task["status"])
        else:
            return

        self._save_agent_task(task)

    def _recover_interrupted_tasks(self, canonical_name: str, worker_pid: Optional[int]) -> None:
        for task in self.agent_queues.get(canonical_name, []):
            task_id = str(task.get("id") or "")
            self._submitted_task_ids.discard(task_id)
            if task.get("status") != "RUNNING" or task.get("worker_pid") != worker_pid:
                continue
            task.update({
                "status": "QUEUED",
                "worker_pid": None,
                "started_at": None,
                "error": "Worker exited before completing the task; task was requeued.",
            })
            self._save_agent_task(task)

    async def _run_worker_supervisor(self) -> None:
        while True:
            while True:
                try:
                    message = self.worker_result_queue.get_nowait()
                except queue.Empty:
                    break
                if isinstance(message, dict):
                    await self._handle_worker_message(message)

            now = time.monotonic()
            for canonical_name, process in list(self.processes.items()):
                if process.is_alive():
                    if now - self._worker_started_monotonic.get(canonical_name, now) >= 30:
                        self._worker_restart_attempts[canonical_name] = 0
                    continue

                if canonical_name not in self._worker_restart_after:
                    attempts = self._worker_restart_attempts[canonical_name] + 1
                    self._worker_restart_attempts[canonical_name] = attempts
                    delay_sec = min(2 ** min(attempts - 1, 5), 30)
                    self._worker_restart_after[canonical_name] = now + delay_sec
                    self._recover_interrupted_tasks(canonical_name, process.pid)
                    state = self.agent_states.get(canonical_name)
                    if state:
                        state.update({"status": "RESTARTING", "pid": None, "worker_phase": "STARTING"})
                    self.append_agent_log(
                        canonical_name,
                        "WORKER_EXITED",
                        f"Worker zakończył pracę (exit={process.exitcode}); ponowne uruchomienie za {delay_sec}s.",
                    )
                    continue

                if now < self._worker_restart_after[canonical_name]:
                    continue

                task_queue = self.worker_task_queues.pop(canonical_name, None)
                if task_queue is not None:
                    task_queue.cancel_join_thread()
                    task_queue.close()
                process.join(timeout=0)
                try:
                    replacement = self._start_agent_worker(canonical_name)
                    self._worker_restart_after.pop(canonical_name, None)
                    state = self.agent_states.get(canonical_name)
                    if state:
                        state.update({
                            "status": "STARTING_LOCAL_WORKER",
                            "pid": replacement.pid,
                            "uid": os.getuid(),
                            "worker_phase": "STARTING",
                        })
                    self.append_agent_log(
                        canonical_name,
                        "WORKER_RESTARTED",
                        f"Uruchomiono ponownie workera PID={replacement.pid}.",
                    )
                    self._submit_pending_agent_tasks()
                except Exception as exc:
                    self._worker_restart_after[canonical_name] = time.monotonic() + min(
                        2 ** min(self._worker_restart_attempts[canonical_name], 5), 30
                    )
                    self.append_agent_log(canonical_name, "WORKER_RESTART_FAILED", str(exc)[:500])

            await asyncio.sleep(0.2)

    def _probe_github_repository(self, repo: str) -> dict[str, Any]:
        """Sprawdza rzeczywisty stan repozytorium GitHub przez oficjalne API."""
        url = f"https://api.github.com/repos/{repo}/contents"
        headers = {"User-Agent": "SVL-Python-OS/5.6.0", "Accept": "application/vnd.github.v3+json"}
        gh_token = os.environ.get("GITHUB_TOKEN", "").strip()
        if gh_token:
            headers["Authorization"] = f"Bearer {gh_token}"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                items = json.loads(resp.read().decode("utf-8"))
                names = [x.get("name") for x in items if isinstance(x, dict)]
                return {
                    "repository": repo,
                    "reachable": True,
                    "http_status": resp.status,
                    "root_entries": names,
                    "verified_at": datetime.now(timezone.utc).isoformat(),
                }
        except Exception as exc:
            return {
                "repository": repo,
                "reachable": False,
                "error": str(exc),
                "verified_at": datetime.now(timezone.utc).isoformat(),
            }

    def _probe_external_running_agents(self) -> dict[str, Any]:
        """
        Sprawdza, czy pod SVL_ORIGINAL_AGENTS_URL działają już zewnętrzne procesy agentów
        (zgodnie z kontraktem originalAgentsStatus.mjs z SVL_System).
        """
        base_url = os.environ.get("SVL_ORIGINAL_AGENTS_URL", "").strip()
        token = os.environ.get("DEBIAN13_ORIGINAL_AGENTS_TOKEN", "").strip()
        if not base_url or not token:
            return {
                "configured": False,
                "external_processes_running": False,
                "reason": "SVL_ORIGINAL_AGENTS_URL / DEBIAN13_ORIGINAL_AGENTS_TOKEN not configured; external process probe skipped.",
            }
        try:
            req = urllib.request.Request(
                f"{base_url.rstrip('/')}/api/agent-tasks/workers",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=3.5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return {
                    "configured": True,
                    "external_processes_running": True,
                    "remote_payload": data,
                }
        except Exception as exc:
            return {
                "configured": True,
                "external_processes_running": False,
                "reason": f"External endpoint unreachable: {exc}",
            }

    async def connect_my_ai(self, triggered_by: str = "operator") -> dict[str, Any]:
        """
        Realizuje polecenie 'podłącz moje ai':
        1. Łączy się z repozytoriami mmitek515-netizen/SVL_System oraz mmitek515-netizen/Debian_13.
        2. Analizuje definicje agentów Aria (si_1), Alex (Alex), Astyria (Astyria), Aurelius (Aurelius).
        3. Ustala, że w repozytorium źródłowym znajdują się definicje programowe (.github/agents/*.agent.md, src/kernel/agents.ts, svl_kernel.py), a nie działające zdalne procesy.
        4. Uruchamia pięć lokalnych workerów i wyraźnie odróżnia ich procesy od zewnętrznych usług.
        5. Przywraca/inicjalizuje ich pamięć wyłącznie na podstawie rzeczywistych danych z repozytorium i bazy SQLite.
        """
        svl_repo_probe, deb_repo_probe, external_probe = await asyncio.gather(
            asyncio.to_thread(self._probe_github_repository, "mmitek515-netizen/SVL_System"),
            asyncio.to_thread(self._probe_github_repository, "mmitek515-netizen/Debian_13"),
            asyncio.to_thread(self._probe_external_running_agents),
        )

        spawned_agents: list[dict[str, Any]] = []
        for name, meta in CANONICAL_SVL_AGENTS.items():
            proc = self.processes.get(name)
            if proc is None or not proc.is_alive():
                proc = self._start_agent_worker(name)

            now_iso = datetime.now(timezone.utc).isoformat()
            # Ensure initial factual memory from repository inspection if empty
            if self._count_memories(name) == 0:
                self.add_agent_memory(
                    canonical_name=name,
                    kind="fact",
                    source="SVL_System_Import",
                    content=(
                        f"Zaimportowano profil agenta {name} (id={meta['id']}) z repozytorium "
                        f"mmitek515-netizen/SVL_System ({meta['source_profile_path']}). "
                        f"Zachowana rola: {meta['preserved_role']}."
                    ),
                )

            cfg = self.get_agent_config(name)
            state = {
                "id": meta["id"],
                "canonical_name": name,
                "display_name": meta["display_name"],
                "slug": meta["slug"],
                "accent_hex": meta["accent_hex"],
                "preserved_role": meta["preserved_role"],
                "capabilities": meta["capabilities"],
                "source_repository": "https://github.com/mmitek515-netizen/SVL_System",
                "source_profile_path": meta["source_profile_path"],
                "source_nature": "SOFTWARE_DEFINITION_ONLY (.github/agents/*.agent.md + src/kernel/agents.ts)",
                "external_process_connected": external_probe["external_processes_running"],
                "instance_origin": "NEW_LOCAL_WORKER_FROM_REPO_CODE",
                "instance_label": "Nowa instancja lokalna uruchomiona na podstawie kodu z SVL_System",
                "status": "ONLINE_LOCAL_WORKER",
                "pid": proc.pid,
                "uid": os.getuid(),
                "heartbeat_at": now_iso,
                "worker_phase": "IDLE",
                "current_task_id": None,
                "memory_scope": f"agent:{name}",
                "memory_entries_count": self._count_memories(name),
                "queue_depth": self._count_pending_agent_tasks(name),
                "config": cfg,
            }
            self.agent_states[name] = state
            self.bus.record_heartbeat(name, state)
            self.kernel.register_agent(meta["id"], state)

            self.append_agent_log(
                name,
                "INFO",
                f"Polecenie 'podłącz moje ai': uruchomiono nową instancję workera (PID={proc.pid}, id={meta['id']}) na bazie definicji z SVL_System.",
            )
            spawned_agents.append(state)

        self.connected_at = datetime.now(timezone.utc).isoformat()
        self._ensure_result_supervisor()
        self._submit_pending_agent_tasks()
        await self.bus.publish(
            topic="svl.agents.connected",
            source=triggered_by,
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={
                "command": "podłącz moje ai",
                "connected_at": self.connected_at,
                "svl_system_reachable": svl_repo_probe["reachable"],
                "debian13_reachable": deb_repo_probe["reachable"],
                "agents": [
                    {"name": a["canonical_name"], "id": a["id"], "pid": a["pid"], "origin": a["instance_origin"]}
                    for a in spawned_agents
                ],
            },
        )
        self.kernel.record_audit(
            actor=triggered_by,
            action="CONNECT_MY_AI",
            target=",".join(CANONICAL_SVL_AGENTS),
            status="SUCCESS",
            details=f"Spawned {len(spawned_agents)} local Python workers from SVL_System definitions (PIDs: {[a['pid'] for a in spawned_agents]})",
        )

        report = {
            "command": "podłącz moje ai",
            "executed_at": self.connected_at,
            "repositories_inspected": {
                "SVL_System": svl_repo_probe,
                "Debian_13": deb_repo_probe,
            },
            "external_process_probe": external_probe,
            "architectural_finding": (
                "W repozytorium SVL_System agenci Aria (id: si_1), Alex (id: Alex), Astyria (id: Astyria) "
                "Aurelius (id: Aurelius) i Agata (id: Agata) istnieją jako definicje programowe (.github/agents/*.agent.md, "
                "src/kernel/agents.ts) bez działających zdalnych daemonów. Zgodnie ze specyfikacją nie zmodyfikowano "
                f"repozytorium źródłowego i uruchomiono {len(spawned_agents)} nowych, rzeczywistych procesów workerów Python na lokalnym hoście Linux, "
                "wyraźnie oznaczone jako nowe instancje lokalne (NEW_LOCAL_WORKER_FROM_REPO_CODE)."
            ),
            "agents": spawned_agents,
        }
        self.last_Sync_report = report
        sync_res = self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id="workers",
            event_type="agents.connected",
            origin=triggered_by,
            payload={
                "connectedAt": self.connected_at,
                "agents": [
                    {"name": a["canonical_name"], "id": a["id"], "pid": a["pid"], "status": a["status"]}
                    for a in spawned_agents
                ],
            },
        )
        report["revision"] = sync_res["revision"]
        report["serverRevision"] = sync_res["serverRevision"]
        return report

    def refresh_states(self) -> list[dict[str, Any]]:
        """Aktualizuje żywe heartbeaty z plików procesów potomnych oraz stan kolejek."""
        result: list[dict[str, Any]] = []
        for name, state in self.agent_states.items():
            proc = self.processes.get(name)
            hb_file = self.runtime_dir / f"{name.lower()}_heartbeat.json"
            if proc and proc.is_alive():
                state["pid"] = proc.pid
                state["uid"] = os.getuid()
                if hb_file.exists():
                    try:
                        hb = json.loads(hb_file.read_text(encoding="utf-8"))
                        if int(hb.get("pid", -1)) == proc.pid:
                            heartbeat_at = str(hb.get("heartbeat_at") or "")
                            state["heartbeat_at"] = heartbeat_at or state.get("heartbeat_at")
                            state["worker_phase"] = str(hb.get("status") or "IDLE")
                            state["current_task_id"] = hb.get("current_task_id")
                            state["uid"] = hb.get("uid", state["uid"])
                            try:
                                age_sec = (
                                    datetime.now(timezone.utc)
                                    - datetime.fromisoformat(heartbeat_at)
                                ).total_seconds()
                            except (TypeError, ValueError):
                                age_sec = float("inf")
                            stale_after = (
                                MAX_AGENT_TASK_TIMEOUT_SEC + 15
                                if state["worker_phase"] == "BUSY"
                                else 6
                            )
                            if age_sec > stale_after:
                                state["status"] = "DEGRADED_LOCAL_WORKER"
                            else:
                                state["status"] = (
                                    "BUSY_LOCAL_WORKER"
                                    if state["worker_phase"] == "BUSY"
                                    else "ONLINE_LOCAL_WORKER"
                                )
                        else:
                            state["status"] = "STARTING_LOCAL_WORKER"
                            state["worker_phase"] = "STARTING"
                    except (OSError, json.JSONDecodeError, TypeError, ValueError):
                        state["status"] = "STARTING_LOCAL_WORKER"
                        state["worker_phase"] = "STARTING"
                else:
                    state["status"] = "STARTING_LOCAL_WORKER"
                    state["worker_phase"] = "STARTING"
            else:
                state["status"] = (
                    "RESTARTING"
                    if name in self._worker_restart_after
                    else "STOPPED"
                )
                state["pid"] = None
                state["worker_phase"] = "STOPPED"

            state["memory_entries_count"] = self._count_memories(name)
            state["queue_depth"] = self._count_pending_agent_tasks(name)
            state["config"] = self.get_agent_config(name)
            state["config_revision"] = self.get_agent_config_revision(name)
            self.bus.record_heartbeat(name, state)
            result.append(state)
        return result

    async def dispatch_agent_task(
        self,
        sender: str,
        target_agent: str,
        task_title: str,
        task_payload: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        ollama_host: Optional[str] = None,
    ) -> dict[str, Any]:
        """Persist a bounded text-inference task and enqueue it for a live worker."""
        target_agent = normalize_agent_canonical_name(target_agent)
        if target_agent not in CANONICAL_SVL_AGENTS:
            raise ValueError(f"Unknown agent: {target_agent}")
        clean_title = str(task_title or "").strip()
        clean_payload = str(task_payload or "").strip()
        if not clean_title:
            raise ValueError("Task title is required.")
        if len(clean_title) > MAX_AGENT_TASK_TITLE_CHARS:
            raise ValueError(f"Task title exceeds {MAX_AGENT_TASK_TITLE_CHARS} characters.")
        if len(clean_payload) > MAX_AGENT_TASK_PAYLOAD_CHARS:
            raise ValueError(f"Task details exceed {MAX_AGENT_TASK_PAYLOAD_CHARS} characters.")
        if self.kernel.operator_token and self.kernel.operator_token in f"{clean_title}\n{clean_payload}":
            raise ValueError("Do not include the operator token in an agent task.")
        if self._count_pending_agent_tasks(target_agent) >= MAX_AGENT_TASKS_PER_AGENT:
            raise RuntimeError(f"Task queue for {target_agent} is full; remove pending tasks before dispatching more.")

        config = self.get_agent_config(target_agent)
        if ollama_host:
            self.ollama_host = str(ollama_host).strip().rstrip("/")
        if not self.ollama_host:
            raise RuntimeError("No Ollama endpoint is configured for worker task execution.")

        task_id = str(uuid.uuid4())
        task_record = {
            "id": task_id,
            "sender": str(sender or "operator").strip()[:120],
            "target_agent": target_agent,
            "target_display_name": CANONICAL_SVL_AGENTS[target_agent]["display_name"],
            "target_id": CANONICAL_SVL_AGENTS[target_agent]["id"],
            "title": clean_title,
            "payload": clean_payload,
            "execution_config": {
                "ollama_model": str(config.get("ollama_model") or "").strip(),
                "temperature": config.get("temperature", 0.7),
                "system_prompt": str(config.get("system_prompt") or ""),
            },
            "status": "QUEUED",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": None,
            "completed_at": None,
            "result": None,
            "error": None,
            "worker_pid": None,
        }
        self._save_agent_task(task_record)
        self._submit_agent_task(task_record)
        self.append_agent_log(target_agent, "TASK_QUEUED", f"Od '{task_record['sender']}': {clean_title}")

        await self.bus.publish(
            topic="svl.agent.task_queued",
            source=target_agent,
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={
                "task_id": task_id,
                "sender": task_record["sender"],
                "target_agent": target_agent,
                "title": clean_title,
                "status": "QUEUED",
            },
        )
        sync_res = self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id=target_agent,
            event_type="agents.task_queued",
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
            payload={
                "taskId": task_id,
                "sender": task_record["sender"],
                "targetAgent": target_agent,
                "title": clean_title,
                "status": "QUEUED",
            },
        )
        task_record.pop("execution_config", None)
        return {
            "task": task_record,
            "resilience": {
                "ok": True,
                "status": "QUEUED",
                "message": "Task was persisted and queued. Completion is reported by the worker status stream.",
            },
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }
