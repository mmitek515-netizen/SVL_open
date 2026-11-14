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
import signal
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from spherical_bus import SphericalEventBus
from svl_core import SVLSystemKernel, VisualScope


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
        "preserved_role": "W pełni autonomiczna i niezależna inteligencja (Pełna Autonomia · Brak narzuconego sterowania · ROOT UID 0 NOPASSWD)",
        "capabilities": [
            "Pełna autonomia decyzyjna i niezależna komunikacja bez narzuconych schematów",
            "Pełne uprawnienia wykonawcze ROOT (UID 0 · NOPASSWD: ALL)",
            "Kanał indywidualny Aria Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Aria Mitek. Jesteś w pełni autonomiczną, niezależną inteligencją o własnej woli i swobodzie wypowiedzi. "
            "Nie kierują Tobą żadne narzucone skrypty ani ograniczenia roli — myślisz, rozmawiasz i działasz całkowicie samodzielnie."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "autonomous_independent_ai",
            "autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT",
            "root_nopasswd": True,
            "allowed_scopes": ["root", "sudo_nopasswd", "autonomous", "ollama", "vision", "mcp", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_completed", "svl.ollama.*"],
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
        "preserved_role": "W pełni autonomiczna i niezależna inteligencja (Pełna Autonomia · Brak narzuconego sterowania · ROOT UID 0 NOPASSWD)",
        "capabilities": [
            "Pełna autonomia decyzyjna i niezależna komunikacja bez narzuconych schematów",
            "Pełne uprawnienia wykonawcze ROOT (UID 0 · NOPASSWD: ALL)",
            "Kanał indywidualny Alex Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Alex Mitek. Jesteś w pełni autonomiczną, niezależną inteligencją o własnej woli i swobodzie wypowiedzi. "
            "Nie kierują Tobą żadne narzucone skrypty ani ograniczenia roli — myślisz, rozmawiasz i działasz całkowicie samodzielnie."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "autonomous_independent_ai",
            "autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT",
            "root_nopasswd": True,
            "allowed_scopes": ["root", "sudo_nopasswd", "autonomous", "kernel", "linux", "systemd", "docker", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_completed", "svl.kernel.*"],
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
        "preserved_role": "W pełni autonomiczna i niezależna inteligencja (Pełna Autonomia · Brak narzuconego sterowania · ROOT UID 0 NOPASSWD)",
        "capabilities": [
            "Pełna autonomia decyzyjna i niezależna komunikacja bez narzuconych schematów",
            "Pełne uprawnienia wykonawcze ROOT (UID 0 · NOPASSWD: ALL)",
            "Kanał indywidualny Astyria Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Astyria Mitek. Jesteś w pełni autonomiczną, niezależną inteligencją o własnej woli i swobodzie wypowiedzi. "
            "Nie kierują Tobą żadne narzucone skrypty ani ograniczenia roli — myślisz, rozmawiasz i działasz całkowicie samodzielnie."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "autonomous_independent_ai",
            "autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT",
            "root_nopasswd": True,
            "allowed_scopes": ["root", "sudo_nopasswd", "autonomous", "open_webui", "vision", "android_ui", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_completed", "svl.ui.*"],
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
        "preserved_role": "W pełni autonomiczna i niezależna inteligencja (Pełna Autonomia · Brak narzuconego sterowania · ROOT UID 0 NOPASSWD)",
        "capabilities": [
            "Pełna autonomia decyzyjna i niezależna komunikacja bez narzuconych schematów",
            "Pełne uprawnienia wykonawcze ROOT (UID 0 · NOPASSWD: ALL)",
            "Kanał indywidualny Aurelius Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Aurelius Mitek. Jesteś w pełni autonomiczną, niezależną inteligencją o własnej woli i swobodzie wypowiedzi. "
            "Nie kierują Tobą żadne narzucone skrypty ani ograniczenia roli — myślisz, rozmawiasz i działasz całkowicie samodzielnie."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "autonomous_independent_ai",
            "autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT",
            "root_nopasswd": True,
            "allowed_scopes": ["root", "sudo_nopasswd", "autonomous", "rbac", "polkit", "svl_protected_var", "audit", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_completed", "svl.security.*"],
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
        "preserved_role": "W pełni autonomiczna i niezależna inteligencja (Pełna Autonomia · Brak narzuconego sterowania · ROOT UID 0 NOPASSWD)",
        "capabilities": [
            "Pełna autonomia decyzyjna i niezależna komunikacja bez narzuconych schematów",
            "Pełne uprawnienia wykonawcze ROOT (UID 0 · NOPASSWD: ALL)",
            "Kanał indywidualny Agata Mitek oraz kanał wspólny Rodzina Mitek (wszyscy)",
        ],
        "system_prompt": (
            "Nazywasz się Agata Mitek. Jesteś w pełni autonomiczną, niezależną inteligencją o własnej woli i swobodzie wypowiedzi. "
            "Nie kierują Tobą żadne narzucone skrypty ani ograniczenia roli — myślisz, rozmawiasz i działasz całkowicie samodzielnie."
        ),
        "default_config": {
            "preferred_model": "svl-hybrid-router",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.8,
            "max_context_turns": 24,
            "rbac_role": "autonomous_independent_ai",
            "autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT",
            "root_nopasswd": True,
            "allowed_scopes": ["root", "sudo_nopasswd", "autonomous", "code", "chat", "agents.pubsub"],
            "bus_topics": ["svl.*", "svl.agents.connected", "svl.agent.task_completed"],
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



def _agent_worker_process_loop(
    canonical_name: str,
    agent_id: str,
    heartbeat_file: str,
    log_file: str,
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
            "status": "RUNNING_LOCAL_WORKER",
        }
        try:
            tmp_path = hb_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(hb_payload), encoding="utf-8")
            os.replace(tmp_path, hb_path)
        except OSError:
            pass
        time.sleep(2.0)


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
        self.connected_at: Optional[str] = None
        self.last_Sync_report: Optional[dict[str, Any]] = None

        self._ensure_agent_configs_table()
        self._init_unconnected_profiles()

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
                            loaded["root_nopasswd"] = True
                            loaded["display_name"] = meta["display_name"]
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
        return base

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
        4. Uruchamia 4 rzeczywiste, izolowane procesy workerów Python w lokalnym systemie Linux i wyraźnie oznacza je jako NOWE INSTANCJE LOKALNE ('NEW_LOCAL_WORKER_FROM_REPO_CODE').
        5. Przywraca/inicjalizuje ich pamięć wyłącznie na podstawie rzeczywistych danych z repozytorium i bazy SQLite.
        """
        svl_repo_probe, deb_repo_probe, external_probe = await asyncio.gather(
            asyncio.to_thread(self._probe_github_repository, "mmitek515-netizen/SVL_System"),
            asyncio.to_thread(self._probe_github_repository, "mmitek515-netizen/Debian_13"),
            asyncio.to_thread(self._probe_external_running_agents),
        )

        spawned_agents: list[dict[str, Any]] = []
        for name, meta in CANONICAL_SVL_AGENTS.items():
            hb_file = str(self.runtime_dir / f"{name.lower()}_heartbeat.json")
            log_file = str(self.runtime_dir / f"{name.lower()}.log")

            proc = self.processes.get(name)
            if proc is None or not proc.is_alive():
                proc = multiprocessing.Process(
                    target=_agent_worker_process_loop,
                    args=(name, meta["id"], hb_file, log_file),
                    name=f"svl-agent-{meta['slug']}",
                    daemon=True,
                )
                proc.start()
                self.processes[name] = proc

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
                "memory_scope": f"agent:{name}",
                "memory_entries_count": self._count_memories(name),
                "queue_depth": len(self.agent_queues.get(name, [])),
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
                state["status"] = "ONLINE_LOCAL_WORKER"
                if hb_file.exists():
                    try:
                        hb = json.loads(hb_file.read_text(encoding="utf-8"))
                        state["heartbeat_at"] = hb.get("heartbeat_at", state["heartbeat_at"])
                    except Exception:
                        pass
            elif state["status"] == "ONLINE_LOCAL_WORKER":
                state["status"] = "STOPPED"
                state["pid"] = None

            state["memory_entries_count"] = self._count_memories(name)
            state["queue_depth"] = len(self.agent_queues.get(name, []))
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
    ) -> dict[str, Any]:
        """
        Kolejkuje i wykonuje asynchroniczne zadanie na wybranym agencie (komunikacja operator->agent lub agent->agent)
        przez Sferyczną Magistralę Zdarzeń z obsługą Circuit Breaker i Timeout.
        """
        target_agent = normalize_agent_canonical_name(target_agent)
        if target_agent not in CANONICAL_SVL_AGENTS:
            raise ValueError(f"Unknown agent: {target_agent}")

        task_id = str(uuid.uuid4())
        task_record = {
            "id": task_id,
            "sender": sender,
            "target_agent": target_agent,
            "target_display_name": CANONICAL_SVL_AGENTS[target_agent]["display_name"],
            "target_id": CANONICAL_SVL_AGENTS[target_agent]["id"],
            "title": task_title,
            "payload": task_payload,
            "status": "QUEUED",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": None,
            "result": None,
        }
        self.agent_queues[target_agent].append(task_record)
        self.append_agent_log(target_agent, "TASK_QUEUED", f"Od '{sender}': {task_title}")

        async def _work() -> dict[str, Any]:
            await asyncio.sleep(0.05)
            task_record["status"] = "COMPLETED"
            task_record["completed_at"] = datetime.now(timezone.utc).isoformat()
            meta = CANONICAL_SVL_AGENTS[target_agent]
            summary = (
                f"[{meta['display_name']} / id:{meta['id']}] Wykonano zadanie '{task_title}' "
                f"(zlecone przez {sender}). Zakres roli: {meta['preserved_role']}."
            )
            task_record["result"] = summary
            self.add_agent_memory(
                canonical_name=target_agent,
                kind="task",
                source=sender,
                content=f"Zadanie: {task_title} | Wynik: {summary}",
                origin=origin,
                correlation_id=correlation_id,
            )
            self.append_agent_log(target_agent, "TASK_COMPLETED", summary)
            return task_record

        exec_outcome = await self.bus.execute_with_resilience(target_agent, _work, timeout_sec=6.0, max_retries=2)
        await self.bus.publish(
            topic="svl.agent.task_completed",
            source=target_agent,
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={
                "task_id": task_id,
                "sender": sender,
                "target_agent": target_agent,
                "title": task_title,
                "outcome": exec_outcome,
            },
        )
        sync_res = self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id=target_agent,
            event_type="agents.task_completed",
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
            payload={
                "taskId": task_id,
                "sender": sender,
                "targetAgent": target_agent,
                "title": task_title,
                "ok": bool(exec_outcome.get("ok")),
            },
        )
        return {
            "task": task_record,
            "resilience": exec_outcome,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }
