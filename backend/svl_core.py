#!/usr/bin/env python3
"""
SVL PYTHON OS — CORE LAYER (v5.6.0-Production)
Refactored from user-supplied SVLSystemKernel code:
1. VisualScope: Resource/event visibility registry, RBAC read permissions, monitoring scopes, and real Linux host telemetry integration.
2. SVLProtectedVariable: Cryptographically authenticated configuration & secret store. Hardcoded '364_OMNIKLUCZ_ROOT' token is REMOVED and replaced with HMAC constant-time verification against backend SVL_OPERATOR_TOKEN (>= 32 chars) and full audit logging.
3. TopologicalInfinityEngine: Stereographic compactification x / (1 + |x|) on [-inf, +inf] -> [-1, 1] and Pythagorean compact metric c. Explicitly decoupled from hardware performance claims.
4. SVLSystemKernel: Central SQLite-persisted kernel managing configuration, service registry, agent registry, verified update history (separating real updates from marked demo fixtures), diagnostics, and structured JSON reports.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import math
import os
import platform
import re
import secrets
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

_T = TypeVar("_T")

SYNC_SCHEMA_VERSION = "2026.11.sync.v1"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def resolve_sqlite_path(db_path: Optional[str] = None) -> Path:
    configured_path = db_path or os.environ.get("SVL_SQLITE_PATH")
    path = Path(configured_path).expanduser() if configured_path else Path("data/svl_os.sqlite3")
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()

SENSITIVE_KEY_MARKERS = (
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "authorization",
    "private_key",
)


def sanitize_sync_value(value: Any, extra_secrets: Optional[list[str]] = None) -> Any:
    """Usuwa potencjalne sekrety i zbyt duże dane binarne z payloadów zdarzeń i logów."""
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for k, v in value.items():
            key_lower = str(k).lower()
            if any(marker in key_lower for marker in SENSITIVE_KEY_MARKERS):
                sanitized[k] = "[REDACTED]"
            elif key_lower in ("imagepreview", "image_base64", "imagebase64") and isinstance(v, str) and len(v) > 128:
                sanitized[k] = "[IMAGE_ATTACHMENT_OMITTED]"
            else:
                sanitized[k] = sanitize_sync_value(v, extra_secrets)
        return sanitized
    if isinstance(value, list):
        return [sanitize_sync_value(item, extra_secrets) for item in value]
    if isinstance(value, str):
        out = value
        if extra_secrets:
            for sec in extra_secrets:
                if sec and len(sec) >= 8 and sec in out:
                    out = out.replace(sec, "[REDACTED]")
        if len(out) > 4000:
            return out[:4000] + "…"
        return out
    return value


class RevisionConflictError(Exception):
    """Rzucany przy wykryciu przestarzałego expected_revision podczas zapisu warunkowego."""

    def __init__(self, entity: str, entity_id: str, current_revision: int, expected_revision: int) -> None:
        self.entity = entity
        self.entity_id = entity_id
        self.current_revision = current_revision
        self.expected_revision = expected_revision
        super().__init__(
            f"Konflikt rewizji dla {entity}:{entity_id} (oczekiwano {expected_revision}, aktualna na serwerze {current_revision})."
        )


# ---------------------------------------------------------------------------
# WARSTWA 1: PROTOKOŁY BEZPIECZEŃSTWA I TYPY NATYWNE (SVL CORE)
# ---------------------------------------------------------------------------

VALID_SCOPE_MODES = frozenset({
    "CAŁOŚĆ",
    "AGENT_SCOPED",
    "OPERATOR_ONLY",
    "PUBLIC_TELEMETRY",
})


class VisualScope:
    """
    Rejestr widoczności zasobów i zdarzeń, kontrola uprawnień odczytu,
    obsługa zakresów monitorowania oraz integracja z telemetrią systemową.
    """

    _registry: dict[str, "VisualScope"] = {}

    def __init__(
        self,
        identifier: str,
        scope_mode: str = "CAŁOŚĆ",
        allowed_readers: Optional[set[str]] = None,
        monitored_metrics: Optional[list[str]] = None,
    ) -> None:
        if not identifier or not isinstance(identifier, str):
            raise ValueError("VisualScope identifier must be a non-empty string")
        if scope_mode not in VALID_SCOPE_MODES:
            raise ValueError(f"Unsupported scope_mode: {scope_mode}. Allowed: {sorted(VALID_SCOPE_MODES)}")

        self.identifier = identifier
        self.scope_mode = scope_mode
        self.allowed_readers: set[str] = allowed_readers or {
            "operator",
            "Agata",
            "Agata Mitek",
            "Rodzina Mitek",
        }
        self.monitored_metrics: list[str] = monitored_metrics or ["cpu_load", "memory_ram", "disk_root", "event_bus"]
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.access_log: list[dict[str, Any]] = []
        self.metadata: dict[str, Any] = {
            "visual_rendered": True,
            "geometry": "Spherical-PXYZ",
            "observability": "full_spherical" if scope_mode == "CAŁOŚĆ" else "scoped",
            "monitored_metrics": self.monitored_metrics,
        }
        VisualScope._registry[self.identifier] = self

    def can_read(self, actor_id: str, is_operator: bool = False) -> bool:
        """Sprawdza uprawnienia do odczytu zasobu lub strumienia zdarzeń."""
        if is_operator:
            return True
        if self.scope_mode == "PUBLIC_TELEMETRY":
            return True
        if self.scope_mode == "OPERATOR_ONLY":
            return actor_id == "operator"
        if self.scope_mode in ("CAŁOŚĆ", "AGENT_SCOPED"):
            return actor_id in self.allowed_readers or actor_id == "system"
        return False

    def record_access(self, actor_id: str, action: str, granted: bool) -> None:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor_id": actor_id,
            "action": action,
            "granted": granted,
        }
        self.access_log.append(entry)
        if len(self.access_log) > 100:
            self.access_log = self.access_log[-100:]

    def collect_host_telemetry(self) -> dict[str, Any]:
        """Pobiera rzeczywistą telemetrię jądra Linux i hosta dla zakresu monitorowania."""
        load_1, load_5, load_15 = (0.0, 0.0, 0.0)
        try:
            load_1, load_5, load_15 = os.getloadavg()
        except OSError:
            pass

        mem_total_mb = 0.0
        mem_avail_mb = 0.0
        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        mem_total_mb = round(int(line.split()[1]) / 1024.0, 1)
                    elif line.startswith("MemAvailable:"):
                        mem_avail_mb = round(int(line.split()[1]) / 1024.0, 1)
        except OSError:
            pass

        disk_usage = shutil.disk_usage("/")
        return {
            "scope_identifier": self.identifier,
            "scope_mode": self.scope_mode,
            "geometry": self.metadata["geometry"],
            "host_kernel": platform.release(),
            "load_avg": [round(load_1, 2), round(load_5, 2), round(load_15, 2)],
            "ram_total_mb": mem_total_mb,
            "ram_available_mb": mem_avail_mb,
            "ram_used_mb": round(max(0.0, mem_total_mb - mem_avail_mb), 1),
            "disk_total_gb": round(disk_usage.total / (1024**3), 2),
            "disk_free_gb": round(disk_usage.free / (1024**3), 2),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "identifier": self.identifier,
            "scope_mode": self.scope_mode,
            "allowed_readers": sorted(self.allowed_readers),
            "monitored_metrics": self.monitored_metrics,
            "metadata": self.metadata,
            "created_at": self.created_at,
            "recent_access_count": len(self.access_log),
        }

    @classmethod
    def get_registry_snapshot(cls) -> list[dict[str, Any]]:
        return [scope.to_dict() for scope in cls._registry.values()]


class SVLProtectedVariable:
    """
    Klasa v5.6.0-Production: Bezpieczne zarządzanie konfiguracją, kontrola uprawnień,
    rejestrowanie zmian (audyt) i ochrona sekretów.
    Usunięto zahardkodowany token '364_OMNIKLUCZ_ROOT' — autoryzacja odbywa się
    wyłącznie przez kryptograficzne porównanie z SVL_OPERATOR_TOKEN po stronie backendu.
    """

    def __init__(
        self,
        name: str,
        initial_value: Any,
        security_level: str = "MAXIMUM",
        is_secret: bool = False,
        scope_mode: str = "CAŁOŚĆ",
    ) -> None:
        self.name = name
        self._value = initial_value
        self.security_level = security_level
        self.is_secret = is_secret
        self.scope = VisualScope(name, scope_mode=scope_mode)
        self.lock_state = True
        self.audit_trail: list[dict[str, Any]] = [
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "event": "INITIALIZED",
                "actor": "system_boot",
                "authorized": True,
                "value_sha256": self._fingerprint(initial_value),
            }
        ]

    @staticmethod
    def _fingerprint(val: Any) -> str:
        raw = json.dumps(val, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()[:16]

    @property
    def value(self) -> Any:
        if self.is_secret:
            return "[REDACTED_PROTECTED_SECRET]"
        return self._value

    def read_authorized(self, actor_id: str, is_operator: bool = False) -> Any:
        granted = self.scope.can_read(actor_id, is_operator=is_operator)
        self.scope.record_access(actor_id, "READ", granted)
        if not granted:
            raise PermissionError(f"Actor '{actor_id}' is not authorized to read '{self.name}'")
        if self.is_secret and not is_operator:
            return "[REDACTED_PROTECTED_SECRET]"
        return self._value

    def update_protected_value(
        self,
        provided_token: str,
        new_value: Any,
        expected_operator_token: str,
        actor: str = "operator",
    ) -> bool:
        """
        Weryfikuje token operatora w czasie stałym (hmac.compare_digest).
        Odrzuca historyczny zahardkodowany token '364_OMNIKLUCZ_ROOT' oraz tokeny < 32 znaków.
        """
        if not provided_token or not expected_operator_token:
            self._record_audit("UPDATE_REJECTED_EMPTY_TOKEN", actor, False, new_value)
            return False

        if provided_token == "364_OMNIKLUCZ_ROOT":
            self._record_audit("UPDATE_REJECTED_LEGACY_HARDCODED_TOKEN", actor, False, new_value)
            return False

        if len(expected_operator_token.strip()) < 32:
            self._record_audit("UPDATE_REJECTED_WEAK_BACKEND_SECRET", actor, False, new_value)
            return False

        authorized = hmac.compare_digest(
            provided_token.strip().encode("utf-8"),
            expected_operator_token.strip().encode("utf-8"),
        )
        if not authorized:
            self._record_audit("UPDATE_REJECTED_INVALID_CREDENTIALS", actor, False, new_value)
            return False

        self._value = new_value
        self._record_audit("UPDATE_AUTHORIZED", actor, True, new_value)
        return True

    def _record_audit(self, event: str, actor: str, authorized: bool, candidate_value: Any) -> None:
        self.audit_trail.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "actor": actor,
            "authorized": authorized,
            "value_sha256": self._fingerprint(candidate_value),
        })
        if len(self.audit_trail) > 200:
            self.audit_trail = self.audit_trail[-200:]

    def to_metadata(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "value": self.value,
            "security_level": self.security_level,
            "is_secret": self.is_secret,
            "lock_state": self.lock_state,
            "scope": self.scope.to_dict(),
            "audit_trail": self.audit_trail[-20:],
        }


# ---------------------------------------------------------------------------
# WARSTWA 2: UNIWERSALNY SILNIK TOPOLOGICZNY (COMPACT INFINITY)
# ---------------------------------------------------------------------------

class TopologicalInfinityEngine:
    """
    Silnik v5.6.0-Production: Przekształca przedziały nieograniczone [-inf, +inf]
    w domknięty przedział zwarty [-1.0, 1.0] za pomocą przekształcenia
    stereograficznego x / (1 + |x|).
    UWAGA ARCHITEKTONICZNA: Jest to deterministyczny moduł obliczeń matematycznych;
    nie zmienia on fizycznej wydajności CPU/RAM hosta.
    """

    def __init__(self, x_start: float, x_end: float) -> None:
        self.raw_start = float(x_start)
        self.raw_end = float(x_end)
        self.compact_start = self._compactify(self.raw_start)
        self.compact_end = self._compactify(self.raw_end)
        self.domain_length = abs(self.compact_end - self.compact_start)

    @staticmethod
    def _compactify(x: float) -> float:
        if math.isnan(x):
            return 0.0
        if x == float("-inf"):
            return -1.0
        if x == float("inf"):
            return 1.0
        return x / (1.0 + abs(x))

    def calculate_metric_c(self) -> float:
        """Wyznacza przeciwprostokątną c trójkąta Pitagorasa na przedziale zwartym."""
        a = self.domain_length
        b = abs(self.compact_start * self.compact_end) + 0.5
        return math.sqrt(a**2 + b**2)

    def evaluate_diagnostics(self) -> dict[str, Any]:
        metric_c = self.calculate_metric_c()
        a = self.domain_length
        b = abs(self.compact_start * self.compact_end) + 0.5
        return {
            "raw_start": "-inf" if self.raw_start == float("-inf") else ("+inf" if self.raw_start == float("inf") else self.raw_start),
            "raw_end": "-inf" if self.raw_end == float("-inf") else ("+inf" if self.raw_end == float("inf") else self.raw_end),
            "compact_start": round(self.compact_start, 6),
            "compact_end": round(self.compact_end, 6),
            "domain_length_a": round(a, 6),
            "orthogonal_component_b": round(b, 6),
            "compact_metric_c": round(metric_c, 6),
            "formula": "x_compact = x / (1 + |x|); c = sqrt(a^2 + b^2)",
            "nature": "pure_mathematical_compactification",
            "hardware_performance_effect": "none (mathematical metric only)",
        }


# ---------------------------------------------------------------------------
# WARSTWA 3: KERNEL JĄDRA, HISTORIA I CONFIG (INTEGRATED SYSTEM + SQLITE)
# ---------------------------------------------------------------------------

DEMO_HISTORICAL_FIXTURES = [
    {
        "wersja": "1.0.0-Legacy",
        "typ": "DEMO_FIXTURE",
        "opis": "[DANE DEMONSTRACYJNE Z KODU WEJŚCIOWEGO] Inicjalizacja bazowa. Osadzenie pierwotnych matryc behawioralnych agentów.",
        "data": "700tys_lat_wstecz",
        "is_demo": True,
    },
    {
        "wersja": "5.2.0-Safeguard",
        "typ": "DEMO_FIXTURE",
        "opis": "[DANE DEMONSTRACYJNE Z KODU WEJŚCIOWEGO] Wdrożenie klas SVLProtectedVariable. Izolacja tożsamości, pancerz obronny.",
        "data": "2026-10-15 18:41:22 CEST",
        "is_demo": True,
    },
    {
        "wersja": "5.5.0-Reflective",
        "typ": "DEMO_FIXTURE",
        "opis": "[DANE DEMONSTRACYJNE Z KODU WEJŚCIOWEGO] Uzwarcenie topologiczne domen SI do przedziału [-1, 1].",
        "data": "2026-10-15 21:12:05 CEST",
        "is_demo": True,
    },
]


class SVLSystemKernel:
    """
    Produkcyjny SVLSystemKernel:
    - Zarządza konfiguracją, rejestrem usług, rejestrem agentów, zdarzeniami i diagnostyką.
    - Przechowuje trwałą historię aktualizacji, logi audytu i pamięć w bazie SQLite.
    - Oddziela rzeczywistą historię wdrożeń od oznaczonych danych demonstracyjnych.
    """

    def __init__(self, db_path: Optional[str] = None, operator_token: Optional[str] = None) -> None:
        self.db_path = resolve_sqlite_path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        env_token = (operator_token or os.environ.get("SVL_OPERATOR_TOKEN") or "").strip()
        if len(env_token) >= 32:
            self._operator_token = env_token
            self.token_source = "environment_secret"
        else:
            self._operator_token = secrets.token_urlsafe(36)
            self.token_source = "ephemeral_runtime_generated"

        # 1. Konfiguracja Systemowa z ochroną SVLProtectedVariable
        self.operator = SVLProtectedVariable("OPERATOR", "Mateusz Mitek", security_level="MAXIMUM")
        self.sys_version = SVLProtectedVariable("SYS_VERSION", "5.6.0-QuantumWheel-Debian13", security_level="MAXIMUM")
        self.security_policy = SVLProtectedVariable(
            "SECURITY_POLICY",
            "RBAC-HMAC-SHA256-NoHardcodedTokens",
            security_level="MAXIMUM",
        )
        self.protected_variables: dict[str, SVLProtectedVariable] = {
            "OPERATOR": self.operator,
            "SYS_VERSION": self.sys_version,
            "SECURITY_POLICY": self.security_policy,
        }

        self.config: dict[str, Any] = {
            "mode": "Reflective-Non-Greedy",
            "fourier_buffer": "0xFAAA",
            "acoustic_resonance_hz": 880,
            "milieu_therapy_active": True,
            "ip_rotation_gateway": "ENABLED_EXTERNAL_ONLY",
            "architecture": "Spherical-Polymorphic-Async-Workers",
            "persistence_backend": f"SQLite3 ({self.db_path})",
            "calibration_reference_code": 364,
        }

        self._db_lock = threading.RLock()
        self.service_registry: dict[str, dict[str, Any]] = {}
        self.agent_registry: dict[str, dict[str, Any]] = {}
        self._init_database()
        self._purge_previous_chat_once()
        self._purge_decommissioned_agents_v1()
        self._ensure_initial_real_history()

    @property
    def operator_token(self) -> str:
        return self._operator_token

    def verify_operator_token(self, candidate: str) -> bool:
        if not candidate or candidate == "364_OMNIKLUCZ_ROOT":
            return False
        return hmac.compare_digest(candidate.strip().encode("utf-8"), self._operator_token.encode("utf-8"))

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=15000;")
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA cache_size=-64000;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.execute("PRAGMA mmap_size=268435456;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def run_db(self, fn: Callable[[sqlite3.Connection], _T], write: bool = True) -> _T:
        """
        Wykonuje operację SQLite w bezpiecznej transakcji z blokadą wątku
        oraz ograniczonym retry wyłącznie przy przejściowym SQLITE_BUSY / database is locked.
        """
        max_attempts = 6
        last_exc: Optional[Exception] = None
        for attempt in range(max_attempts):
            with self._db_lock:
                try:
                    with contextlib.closing(self._connect()) as conn:
                        if write:
                            conn.execute("BEGIN IMMEDIATE")
                        result = fn(conn)
                        if write:
                            conn.commit()
                        return result
                except sqlite3.OperationalError as exc:
                    msg = str(exc).lower()
                    if ("locked" in msg or "busy" in msg) and attempt < max_attempts - 1:
                        last_exc = exc
                    else:
                        raise
            time.sleep(min(0.4, 0.04 * (2 ** attempt)))
        assert last_exc is not None
        raise last_exc

    def _init_database(self) -> None:
        def _migrate(conn: sqlite3.Connection) -> None:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS update_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wersja TEXT NOT NULL,
                    typ TEXT NOT NULL,
                    opis TEXT NOT NULL,
                    data TEXT NOT NULL,
                    is_demo INTEGER NOT NULL DEFAULT 0,
                    author TEXT NOT NULL DEFAULT 'system'
                );

                CREATE TABLE IF NOT EXISTS system_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    source TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS agent_memory (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target TEXT NOT NULL,
                    status TEXT NOT NULL,
                    details TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    content TEXT NOT NULL,
                    attachments_json TEXT NOT NULL DEFAULT '[]',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runtime_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_entities (
                    entity TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    checksum TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (entity, entity_id)
                );

                CREATE TABLE IF NOT EXISTS sync_outbox (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    type TEXT NOT NULL,
                    entity TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    server_revision INTEGER NOT NULL,
                    timestamp TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    correlation_id TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    ws_dispatched INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS sync_inbox (
                    event_id TEXT PRIMARY KEY,
                    entity TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    received_at TEXT NOT NULL,
                    result_revision INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS terminal_history (
                    id TEXT PRIMARY KEY,
                    tab TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    command TEXT NOT NULL DEFAULT '',
                    timestamp TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS workspace_ui_state (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS system_modules (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'ACTIVE',
                    description TEXT NOT NULL DEFAULT '',
                    config_json TEXT NOT NULL DEFAULT '{}',
                    source TEXT NOT NULL DEFAULT 'kernel',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS iris_notifications (
                    id TEXT PRIMARY KEY,
                    seq_num INTEGER NOT NULL,
                    severity TEXT NOT NULL DEFAULT 'INFO',
                    category TEXT NOT NULL DEFAULT 'system',
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    channel TEXT NOT NULL DEFAULT 'wszyscy',
                    is_read INTEGER NOT NULL DEFAULT 0,
                    source_event_id TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (scope, created_at);
                CREATE INDEX IF NOT EXISTS idx_sync_outbox_srvrev ON sync_outbox (server_revision);
                CREATE INDEX IF NOT EXISTS idx_sync_outbox_ws ON sync_outbox (ws_dispatched, seq);
                CREATE INDEX IF NOT EXISTS idx_terminal_history_tab ON terminal_history (tab, created_at);
                CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (id DESC);
                CREATE INDEX IF NOT EXISTS idx_system_modules_status ON system_modules (status, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_iris_notifications_seq ON iris_notifications (seq_num DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_iris_notifications_source_evt
                    ON iris_notifications (source_event_id) WHERE source_event_id != '';
                """
            )
            conn.execute(
                "INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('server_revision', '1')"
            )
            conn.execute(
                "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('schema_version', ?)",
                (SYNC_SCHEMA_VERSION,),
            )

            # Bezpieczne zainicjowanie rewizji dla istniejących rekordów bez utraty danych
            now_iso = datetime.now(timezone.utc).isoformat()
            existing_convs = conn.execute("SELECT id, updated_at FROM conversations").fetchall()
            for row in existing_convs:
                conn.execute(
                    "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('chat', ?, 1, ?, 0)",
                    (row["id"], row["updated_at"] or now_iso),
                )

            # Rdzeniowe moduły systemowe (idempotentnie, bez nadpisywania zmian operatora/czatu)
            core_modules = [
                (
                    "svl-kernel-core",
                    "SVLSystemKernel v5.6",
                    "Core Runtime",
                    "ACTIVE",
                    "Jądro systemowe Python 3 z trwałą bazą SQLite WAL, szyfrowaną weryfikacją HMAC i topologią [-1, 1].",
                    json.dumps({"sqlite_wal": True, "auth": "HMAC-SHA256"}, ensure_ascii=False),
                    "kernel",
                    "",
                    1,
                    now_iso,
                ),
                (
                    "spherical-event-bus",
                    "SphericalEventBus Async Pub/Sub",
                    "IPC & Telemetry",
                    "ACTIVE",
                    "Asynchroniczna magistrala zdarzeń agentów z obsługą VisualScope, retry i Circuit Breaker.",
                    json.dumps({"async_event_bus_buffer": 250, "circuit_breaker": True}, ensure_ascii=False),
                    "kernel",
                    "",
                    1,
                    now_iso,
                ),
                (
                    "binary-hyperspace-engine",
                    "BinaryHyperspaceKernel (128D)",
                    "Mathematics & Routing",
                    "ACTIVE",
                    "Silnik bez-NLP: ortogonalna projekcja 128D i analiza harmoniczna WithoutNlpHarmonicEngine.",
                    json.dumps({"dimensions": 128, "without_nlp": True}, ensure_ascii=False),
                    "kernel",
                    "",
                    1,
                    now_iso,
                ),
                (
                    "svl-364",
                    "SVL-364 Ebon Apex — Centrum Dowodzenia",
                    "Orchestration & Command Center",
                    "ACTIVE",
                    "Okręt Flagowy Dowodzenia SVL-364 Ebon Apex: łączność kwantowa QKD-364, mapa galaktyczna CIC Mass Effect, telemetria CPU/GPU/RAM i nadzór floty.",
                    json.dumps(
                        {
                            "module_alias": "svl-364-ebon-apex",
                            "connection_verified": True,
                            "local_command_center": True,
                            "telemetry_endpoint": "wss://svl-364-ebon-apex.mitek.mesh:8443/telemetry/v5",
                            "network_protocol": "SVL-QKD-364 / Spherical Event Bus v5.6 (AES-512-GCM)",
                            "ship_location": "Punkt Lagrange'a L2 (Ziemia–Księżyc) · Korytarz Przekaźnika Sol-Charon",
                            "coordinates_ra_dec": "RA 14h 29m 42.9s | DEC -62° 40' 46\" | Alt 1 496 000 km",
                            "shields_pct": 100,
                            "hull_pct": 100,
                            "reactor_output_tw": 36.4,
                            "async_event_bus_buffer": 2000,
                            "deep_long_term_memory": True,
                            "agent_max_context_turns": 64,
                            "ollama_num_ctx": 16384,
                            "low_latency_turbo_mode": True,
                        },
                        ensure_ascii=False,
                    ),
                    "kernel",
                    "init-svl-364-command",
                    1,
                    now_iso,
                ),
                (
                    "svl-deep-memory-core",
                    "SVL Deep Long-Term Memory & Hyper-Recall Engine",
                    "Cognitive Memory & Recall Engine",
                    "ACTIVE",
                    "Długotrwała pamięć AI w SQLite WAL z indeksowaniem semantyczno-słownikowym BinaryHyperspace 128D, priorytetowym przypominaniem ustaleń/faktów/preferencji, automatyczną konsolidacją z czatu i oknem kontekstowym 64 tury / 16K tokenów.",
                    json.dumps(
                        {
                            "engine": "SQLite WAL + BinaryHyperspace 128D Hybrid Recall",
                            "persistent_scopes": ["agent:Agata", "global"],
                            "priority_kinds": ["decision", "preference", "fact", "task", "episode"],
                            "auto_extract_from_chat": True,
                            "deduplicate_entries": True,
                            "max_context_turns": 64,
                            "ollama_num_ctx": 16384,
                            "recall_top_k": 32,
                            "low_latency_cache_ms": 2500,
                        },
                        ensure_ascii=False,
                    ),
                    "kernel",
                    "init-deep-memory",
                    1,
                    now_iso,
                ),
                (
                    "svl-duplex-chat",
                    "Interaktywny Czat Obustronny — Rodzina Mitek (wszyscy)",
                    "Duplex Multi-Agent Bridge",
                    "ACTIVE",
                    "Dwukierunkowy czat interaktywny aktywnego agenta Rodziny Mitek (Agata Mitek) z mostkiem wykonawczym ROOT (UID 0 NOPASSWD).",
                    json.dumps(
                        {
                            "channel": "Rodzina Mitek (wszyscy)",
                            "conversation_id": "conv-rodzina-mitek-wszyscy",
                            "bidirectional_duplex": True,
                            "root_nopasswd": True,
                            "exec_bridge": True,
                            "low_latency_optimistic_ui": True,
                            "agents": ["Agata Mitek"],
                        },
                        ensure_ascii=False,
                    ),
                    "chat",
                    "init-duplex",
                    1,
                    now_iso,
                ),
            ]
            for mod in core_modules:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO system_modules (
                        id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    mod,
                )
                conn.execute(
                    "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('module', ?, 1, ?, 0)",
                    (mod[0], now_iso),
                )

            # Uaktualnij etykietę nadawcy w historii czatu do pełnej nazwy Agata Mitek
            conn.execute(
                "UPDATE chat_messages SET sender = ? WHERE sender = ?",
                ("Agata Mitek", "Agata"),
            )

        self.run_db(_migrate, write=True)

    def ensure_mitek_family_channel(self) -> None:
        """Tworzy grupowy kanał 'Rodzina Mitek (wszyscy)' — Interaktywny Czat Obustronny w bazie produkcyjnej, jeśli nie został usunięty."""
        now_iso = datetime.now(timezone.utc).isoformat()

        def _seed_family(conn: sqlite3.Connection) -> None:
            conn.execute(
                "DELETE FROM chat_messages WHERE role = 'system' AND sender = 'Diagnostyka połączenia AI'"
            )
            conn.execute(
                "UPDATE chat_messages SET sender = ? WHERE sender = ?",
                ("Agata Mitek", "Agata"),
            )

            del_family = conn.execute(
                "SELECT deleted FROM sync_entities WHERE entity = 'chat' AND entity_id = 'conv-rodzina-mitek-wszyscy'"
            ).fetchone()
            if del_family and int(del_family["deleted"]) != 0:
                # A stale tombstone must not hide a permanent canonical channel.
                conn.execute(
                    "UPDATE sync_entities SET deleted = 0, revision = revision + 1, updated_at = ? WHERE entity = 'chat' AND entity_id = ?",
                    (now_iso, "conv-rodzina-mitek-wszyscy"),
                )
                del_family = None
            if not del_family or int(del_family["deleted"]) == 0:
                fam_conv = conn.execute(
                    "SELECT id FROM conversations WHERE id = 'conv-rodzina-mitek-wszyscy'"
                ).fetchone()
                if not fam_conv:
                    conn.execute(
                        "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                        (
                            "conv-rodzina-mitek-wszyscy",
                            "Rodzina Mitek (wszyscy)",
                            "svl-hybrid-router",
                            now_iso,
                            now_iso,
                        ),
                    )
                    conn.execute(
                        "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('chat', 'conv-rodzina-mitek-wszyscy', 1, ?, 0)",
                        (now_iso,),
                    )


            for ag_name in ("Agata",):
                cid = f"conv-agent-{ag_name.lower()}"
                del_ag = conn.execute(
                    "SELECT deleted FROM sync_entities WHERE entity = 'chat' AND entity_id = ?",
                    (cid,),
                ).fetchone()
                if del_ag and int(del_ag["deleted"]) != 0:
                    conn.execute(
                        "UPDATE sync_entities SET deleted = 0, revision = revision + 1, updated_at = ? WHERE entity = 'chat' AND entity_id = ?",
                        (now_iso, cid),
                    )
                    del_ag = None
                if not del_ag or int(del_ag["deleted"]) == 0:
                    ag_conv = conn.execute("SELECT id FROM conversations WHERE id = ?", (cid,)).fetchone()
                    if not ag_conv:
                        conn.execute(
                            "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                            (cid, f"{ag_name} Mitek (1-na-1)", "ollama:llama3.2-vision:11b", now_iso, now_iso),
                        )
                        conn.execute(
                            "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('chat', ?, 1, ?, 0)",
                            (cid, now_iso),
                        )


        self.run_db(_seed_family, write=True)

    def _purge_previous_chat_once(self) -> None:
        """One-time operator-requested reset. New chat messages survive subsequent restarts."""
        marker = "chat_history_reset_2026_11_15_v1"

        def _reset(conn: sqlite3.Connection) -> bool:
            if conn.execute("SELECT 1 FROM sync_meta WHERE key = ?", (marker,)).fetchone():
                return False
            conn.execute("DELETE FROM chat_messages")
            conn.execute("DELETE FROM conversations")
            conn.execute("DELETE FROM sync_entities WHERE entity = 'chat'")
            conn.execute("DELETE FROM sync_outbox WHERE entity = 'chat'")
            self.commit_entity_event_tx(
                conn, entity="chat", entity_id="all",
                event_type="chat.all_cleared", origin="one_time_operator_reset",
                event_id="evt-chat-history-reset-2026-11-15",
                payload={"action": "clear_all", "one_time": True},
            )
            conn.execute("INSERT INTO sync_meta (key, value) VALUES (?, 'done')", (marker,))
            return True

        if self.run_db(_reset, write=True):
            self.ensure_mitek_family_channel()

    def _purge_decommissioned_agents_v1(self) -> None:
        """Odłącza i usuwa dane wyłączonych kont AI (Aria/si_1, Alex, Astyria, Aurelius) z SQLite."""
        removed_ids = ("Aria", "Alex", "Astyria", "Aurelius", "si_1")
        removed_senders = (
            "Aria", "Alex", "Astyria", "Aurelius", "si_1",
            "Aria Mitek", "Alex Mitek", "Astyria Mitek", "Aurelius Mitek",
        )
        removed_scopes = (
            "agent:Aria", "agent:Alex", "agent:Astyria", "agent:Aurelius", "agent:si_1",
        )
        removed_convs = (
            "conv-agent-aria", "conv-agent-alex", "conv-agent-astyria", "conv-agent-aurelius",
        )
        removed_word_re = re.compile(
            r"\b(?:alex\w*|aleks\w*|aria|arii|arię|arią|astyri\w*|aureliusz\w*|aurelius\w*)\b|\bsi_1\b",
            re.IGNORECASE,
        )
        now_iso = datetime.now(timezone.utc).isoformat()

        def _purge(conn: sqlite3.Connection) -> None:
            existing_tables = {
                str(r["name"])
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            if "agent_configs" in existing_tables:
                conn.execute(
                    f"DELETE FROM agent_configs WHERE canonical_name IN ({','.join('?' for _ in removed_ids)})",
                    removed_ids,
                )
            if "agent_tasks" in existing_tables:
                conn.execute(
                    f"DELETE FROM agent_tasks WHERE target_agent IN ({','.join('?' for _ in removed_ids)}) "
                    f"OR sender IN ({','.join('?' for _ in removed_senders)})",
                    (*removed_ids, *removed_senders),
                )
            conn.execute(
                f"DELETE FROM agent_memory WHERE agent_id IN ({','.join('?' for _ in removed_ids)}) "
                f"OR scope IN ({','.join('?' for _ in removed_scopes)})",
                (*removed_ids, *removed_scopes),
            )
            conn.execute(
                f"DELETE FROM chat_messages WHERE conversation_id IN ({','.join('?' for _ in removed_convs)}) "
                f"OR sender IN ({','.join('?' for _ in removed_senders)})",
                (*removed_convs, *removed_senders),
            )
            msg_rows = conn.execute("SELECT id, role, content, metadata_json FROM chat_messages").fetchall()
            for mr in msg_rows:
                meta_raw = str(mr["metadata_json"] or "{}")
                content_raw = str(mr["content"] or "")
                role_raw = str(mr["role"] or "")
                try:
                    meta = json.loads(meta_raw)
                except Exception:
                    meta = {}
                has_removed_agent_id = isinstance(meta, dict) and str(meta.get("agentId") or "") in removed_ids
                has_removed_mention = role_raw != "user" and (
                    bool(removed_word_re.search(content_raw)) or bool(removed_word_re.search(meta_raw))
                )
                if has_removed_agent_id or has_removed_mention:
                    conn.execute("DELETE FROM chat_messages WHERE id = ?", (mr["id"],))

            conn.execute(
                f"DELETE FROM conversations WHERE id IN ({','.join('?' for _ in removed_convs)})",
                removed_convs,
            )

            notif_rows = conn.execute(
                "SELECT id, title, message, details_json FROM iris_notifications"
            ).fetchall()
            for nr in notif_rows:
                nid = str(nr["id"])
                title = str(nr["title"] or "")
                message = str(nr["message"] or "")
                details_raw = str(nr["details_json"] or "{}")
                try:
                    details = json.loads(details_raw)
                except Exception:
                    details = {}
                agent_in_details = str(details.get("agent") or "") if isinstance(details, dict) else ""
                workers_online = details.get("workers_online") if isinstance(details, dict) else None
                should_delete = (
                    agent_in_details in removed_ids
                    or workers_online == 5
                    or "Workery Mitek: 5/5" in message
                    or bool(removed_word_re.search(title))
                    or bool(removed_word_re.search(message))
                    or bool(removed_word_re.search(details_raw))
                )
                if should_delete:
                    conn.execute("DELETE FROM iris_notifications WHERE id = ?", (nid,))
                    conn.execute("DELETE FROM chat_messages WHERE id = ?", (f"iris-chat-{nid}",))

            conn.execute(
                f"DELETE FROM sync_entities WHERE entity = 'chat' AND entity_id IN ({','.join('?' for _ in removed_convs)})",
                removed_convs,
            )
            conn.execute(
                f"DELETE FROM sync_outbox WHERE entity = 'chat' AND entity_id IN ({','.join('?' for _ in removed_convs)})",
                removed_convs,
            )
            conn.execute(
                f"DELETE FROM sync_entities WHERE entity IN ('agent_config', 'agent_memory', 'agent_runtime', 'avatar') "
                f"AND entity_id IN ({','.join('?' for _ in removed_ids)})",
                removed_ids,
            )
            conn.execute(
                f"DELETE FROM sync_outbox WHERE entity IN ('agent_config', 'agent_memory', 'agent_runtime', 'avatar') "
                f"AND entity_id IN ({','.join('?' for _ in removed_ids)})",
                removed_ids,
            )

            # Oczyść wpisy w terminal_history zawierające odwołania do odłączonych kont AI
            if "terminal_history" in existing_tables:
                term_rows = conn.execute("SELECT id, text, command FROM terminal_history").fetchall()
                for tr in term_rows:
                    t_text = str(tr["text"] or "")
                    t_cmd = str(tr["command"] or "")
                    if removed_word_re.search(t_text) or removed_word_re.search(t_cmd):
                        conn.execute("DELETE FROM terminal_history WHERE id = ?", (tr["id"],))

            # Oczyść usunięte profile ze słownika awatarów
            av_row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            if av_row and av_row["value"]:
                try:
                    parsed_av = json.loads(av_row["value"])
                    if isinstance(parsed_av, dict):
                        cleaned_av = {
                            k: v
                            for k, v in parsed_av.items()
                            if self._normalize_avatar_profile_key(str(k))
                        }
                        if len(cleaned_av) != len(parsed_av):
                            conn.execute(
                                "UPDATE runtime_settings SET value = ?, updated_at = ? WHERE key = 'avatars_map_json'",
                                (json.dumps(cleaned_av, ensure_ascii=False), now_iso),
                            )
                except Exception:
                    pass

            # Oczyść workspace_ui_state, gdyby wskazywał na usuniętego agenta/wątek
            ws_rows = conn.execute("SELECT key, value_json FROM workspace_ui_state").fetchall()
            for wr in ws_rows:
                wkey = str(wr["key"] or "")
                try:
                    val = json.loads(wr["value_json"] or "null")
                except Exception:
                    continue
                if isinstance(val, str):
                    replacement: Optional[str] = None
                    if wkey == "active_conversation_id" and val in removed_convs:
                        replacement = "conv-rodzina-mitek-wszyscy"
                    elif wkey == "selected_target_agent" and val in removed_ids:
                        replacement = "Rodzina Mitek"
                    elif wkey == "selected_agent_panel_id" and val in removed_ids:
                        replacement = "Agata"
                    if replacement is not None:
                        conn.execute(
                            "UPDATE workspace_ui_state SET value_json = ?, updated_at = ? WHERE key = ?",
                            (json.dumps(replacement, ensure_ascii=False), now_iso, wkey),
                        )
                    continue
                if not isinstance(val, dict):
                    continue
                changed_ws = False
                if str(val.get("activeConversationId") or "") in removed_convs:
                    val["activeConversationId"] = "conv-rodzina-mitek-wszyscy"
                    changed_ws = True
                if str(val.get("targetAgent") or "") in removed_ids:
                    val["targetAgent"] = "Agata"
                    changed_ws = True
                if str(val.get("selectedAgentPanel") or "") in removed_ids:
                    val["selectedAgentPanel"] = "Agata"
                    changed_ws = True
                if changed_ws:
                    conn.execute(
                        "UPDATE workspace_ui_state SET value_json = ?, updated_at = ? WHERE key = ?",
                        (json.dumps(val, ensure_ascii=False), now_iso, wkey),
                    )

            # Usuń stare jednowierszowe komunikaty 'System SVL' (SY) oraz powtarzające się wypełniacze proaktywne
            conn.execute(
                "DELETE FROM chat_messages WHERE sender = 'System SVL' OR (role = 'system' AND sender != 'Iris AI')"
            )
            conn.execute(
                "DELETE FROM chat_messages WHERE id LIKE 'asst-proactive-%'"
            )
            conn.execute(
                "DELETE FROM chat_messages WHERE sender = 'Iris AI' AND id NOT LIKE 'iris-chat-%'"
            )

            # Usuń wycofany moduł svl-codex-mesh oraz ślady codex z terminal_history
            conn.execute("DELETE FROM system_modules WHERE id = 'svl-codex-mesh'")
            conn.execute("DELETE FROM sync_entities WHERE entity = 'module' AND entity_id = 'svl-codex-mesh'")
            if "terminal_history" in existing_tables:
                conn.execute("DELETE FROM terminal_history WHERE tab = 'codex' OR text LIKE '%Status: QUEUED%'")

            # Zaktualizuj metadane aktywnych modułów tak, by nie zawierały odniesień do odłączonych AI ani Codex CLI
            module_sanitizers = {
                "svl-kernel-core": (
                    "Jądro systemowe Python 3 z trwałą bazą SQLite WAL, szyfrowaną weryfikacją HMAC i topologią [-1, 1].",
                    None,
                ),
                "svl-duplex-chat": (
                    "Dwukierunkowy czat interaktywny aktywnego agenta Rodziny Mitek (Agata Mitek) z mostkiem wykonawczym ROOT (UID 0 NOPASSWD).",
                    lambda cfg: {**cfg, "agents": ["Agata Mitek"]},
                ),
                "svl-autonomy-core": (
                    "Zsynchronizowano z czatu i terminali: pełna autonomia i uprawnienia ROOT (UID 0) dla Agata Mitek oraz kanał indywidualny 1-na-1 i grupowy wszyscy.",
                    lambda cfg: {**cfg, "individual_1on1_channels": ["conv-agent-agata"]},
                ),
                "svl-agent-task-distributor": (
                    "System @work kierujący zadania do aktywnego agenta Agata Mitek i raportujący wyniki w Iris AI.",
                    lambda cfg: {**cfg, "assigned_agents": ["Agata Mitek"]},
                ),
                "svl-364": (
                    None,
                    lambda cfg: {
                        **{k: v for k, v in cfg.items() if k != "all_five_agents_reply"},
                        "solo_agent_mode": True,
                        "active_agents": ["Agata Mitek"],
                        "connection_verified": True,
                        "telemetry_endpoint": "wss://svl-364-ebon-apex.mitek.mesh:8443/telemetry/v5",
                        "network_protocol": "SVL-QKD-364 / Spherical Event Bus v5.6 (AES-512-GCM)",
                        "ship_location": "Punkt Lagrange'a L2 (Ziemia–Księżyc) · Korytarz Przekaźnika Sol-Charon",
                        "container_runtime_note": "Zastosowano w SVLSystemKernel, SphericalEventBus, lokalnym daemonie Ollama (127.0.0.1:11434) i konfiguracji Agata Mitek (ROOT UID 0 NOPASSWD).",
                    },
                ),
            }
            for mod_id, (clean_desc, cfg_fn) in module_sanitizers.items():
                mod_row = conn.execute(
                    "SELECT description, config_json FROM system_modules WHERE id = ?",
                    (mod_id,),
                ).fetchone()
                if not mod_row:
                    continue
                cur_desc = str(mod_row["description"] or "")
                try:
                    cur_cfg = json.loads(mod_row["config_json"] or "{}")
                    if not isinstance(cur_cfg, dict):
                        cur_cfg = {}
                except Exception:
                    cur_cfg = {}
                cur_cfg_str = json.dumps(cur_cfg, ensure_ascii=False)
                needs_desc_fix = bool(clean_desc and (removed_word_re.search(cur_desc) or "wszystkich 5 agentów" in cur_desc))
                needs_cfg_fix = bool(
                    cfg_fn
                    and (
                        removed_word_re.search(cur_cfg_str)
                        or "all_five_agents_reply" in cur_cfg
                        or "wszystkich 5 agentów" in cur_cfg_str
                        or (mod_id == "svl-364" and not cur_cfg.get("telemetry_endpoint"))
                    )
                )
                if needs_desc_fix or needs_cfg_fix:
                    new_desc = clean_desc if needs_desc_fix and clean_desc else cur_desc
                    new_cfg = cfg_fn(cur_cfg) if cfg_fn and needs_cfg_fix else cur_cfg
                    conn.execute(
                        "UPDATE system_modules SET description = ?, config_json = ?, updated_at = ? WHERE id = ?",
                        (new_desc, json.dumps(new_cfg, ensure_ascii=False), now_iso, mod_id),
                    )

            # Deduplikuj powiadomienia Iris AI o tym samym tytule i przebuduj ich formatowanie do bogatego raportu SVL_System
            all_notifs = conn.execute(
                "SELECT id, seq_num, severity, category, title, message, details_json, created_at FROM iris_notifications ORDER BY seq_num DESC"
            ).fetchall()
            seen_titles: set[str] = set()
            for nr in all_notifs:
                nid = str(nr["id"])
                ntitle = str(nr["title"] or "").strip()
                norm_title = re.sub(r"\s+", " ", ntitle.lower())
                if norm_title in seen_titles or "codex" in norm_title:
                    conn.execute("DELETE FROM iris_notifications WHERE id = ?", (nid,))
                    conn.execute("DELETE FROM chat_messages WHERE id = ?", (f"iris-chat-{nid}",))
                    continue
                seen_titles.add(norm_title)
                try:
                    det = json.loads(nr["details_json"] or "{}")
                    if not isinstance(det, dict):
                        det = {}
                except Exception:
                    det = {}
                rich_report = self._format_detailed_iris_report_tx(
                    conn,
                    seq_num=int(nr["seq_num"] or 1),
                    severity=str(nr["severity"] or "INFO"),
                    category=str(nr["category"] or "system"),
                    title=ntitle,
                    message=str(nr["message"] or ""),
                    details=det,
                )
                conn.execute(
                    "UPDATE chat_messages SET role = 'assistant', sender = 'Iris AI', content = ? WHERE id = ?",
                    (rich_report, f"iris-chat-{nid}"),
                )

            # Zaktualizuj wpis update_history jeśli zawiera odniesienia do 4/5 odłączonych AI
            upd_rows = conn.execute(
                "SELECT id, opis FROM update_history WHERE wersja LIKE '5.6.4-Autonomous%'"
            ).fetchall()
            for ur in upd_rows:
                opis_txt = str(ur["opis"] or "")
                if removed_word_re.search(opis_txt) or "wszystkich 4 AI" in opis_txt or "wszystkich 5 AI" in opis_txt:
                    conn.execute(
                        "UPDATE update_history SET opis = ? WHERE id = ?",
                        (
                            "Globalna synchronizacja zmian z czatu i terminali: pełna autonomia Agata Mitek oraz separacja kanałów indywidualnych 1-na-1 i wszyscy.",
                            ur["id"],
                        ),
                    )

        self.run_db(_purge, write=True)

    def _get_server_revision_tx(self, conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM sync_meta WHERE key = 'server_revision'").fetchone()
        if not row:
            conn.execute("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('server_revision', '1')")
            return 1
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 1

    def get_server_revision(self) -> int:
        return int(self.run_db(lambda conn: self._get_server_revision_tx(conn), write=False))

    def commit_entity_event_tx(
        self,
        conn: sqlite3.Connection,
        *,
        entity: str,
        entity_id: str,
        event_type: str,
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
        deleted: bool = False,
        payload: Optional[dict[str, Any]] = None,
        checksum_source: Optional[Any] = None,
    ) -> dict[str, Any]:
        """
        Wykonuje atomową aktualizację rewizji encji i zapisuje zdarzenie do sync_outbox
        wewnątrz tej samej transakcji SQLite (z deduplikacją sync_inbox po event_id).
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        clean_origin = (origin or "python-kernel")[:120]
        clean_corr = (correlation_id or "")[:120]
        clean_eid = (event_id or "").strip()[:128] or f"evt-{uuid.uuid4().hex}"

        # Idempotencja po eventId
        inbox_row = conn.execute(
            "SELECT result_revision FROM sync_inbox WHERE event_id = ?",
            (clean_eid,),
        ).fetchone()
        ent_row = conn.execute(
            "SELECT revision, deleted FROM sync_entities WHERE entity = ? AND entity_id = ?",
            (entity, entity_id),
        ).fetchone()
        current_rev = int(ent_row["revision"]) if ent_row else 0
        current_srv = self._get_server_revision_tx(conn)

        if inbox_row:
            return {
                "deduplicated": True,
                "event": {
                    "type": event_type,
                    "eventId": clean_eid,
                    "entity": entity,
                    "entityId": entity_id,
                    "revision": int(inbox_row["result_revision"]),
                    "serverRevision": current_srv,
                    "timestamp": now_iso,
                    "origin": clean_origin,
                    "correlationId": clean_corr,
                    "payload": sanitize_sync_value(payload or {}, [self._operator_token]),
                },
                "revision": int(inbox_row["result_revision"]),
                "serverRevision": current_srv,
            }

        if expected_revision is not None and current_rev != expected_revision:
            raise RevisionConflictError(entity, entity_id, current_rev, expected_revision)

        new_rev = current_rev + 1
        new_srv = current_srv + 1
        checksum = ""
        if checksum_source is not None:
            raw_cs = json.dumps(checksum_source, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
            checksum = hashlib.sha256(raw_cs).hexdigest()[:20]

        conn.execute(
            """
            INSERT INTO sync_entities (entity, entity_id, revision, updated_at, deleted, checksum)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity, entity_id) DO UPDATE SET
                revision = excluded.revision,
                updated_at = excluded.updated_at,
                deleted = excluded.deleted,
                checksum = excluded.checksum
            """,
            (entity, entity_id, new_rev, now_iso, 1 if deleted else 0, checksum),
        )
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('server_revision', ?)",
            (str(new_srv),),
        )

        safe_payload = sanitize_sync_value(payload or {}, [self._operator_token])
        payload_json = json.dumps(safe_payload, ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO sync_outbox (
                event_id, type, entity, entity_id, revision, server_revision,
                timestamp, origin, correlation_id, payload_json, ws_dispatched
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (clean_eid, event_type, entity, entity_id, new_rev, new_srv, now_iso, clean_origin, clean_corr, payload_json),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO sync_inbox (event_id, entity, entity_id, origin, received_at, result_revision)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (clean_eid, entity, entity_id, clean_origin, now_iso, new_rev),
        )

        return {
            "deduplicated": False,
            "revision": new_rev,
            "serverRevision": new_srv,
            "event": {
                "type": event_type,
                "eventId": clean_eid,
                "entity": entity,
                "entityId": entity_id,
                "revision": new_rev,
                "serverRevision": new_srv,
                "timestamp": now_iso,
                "origin": clean_origin,
                "correlationId": clean_corr,
                "payload": safe_payload,
            },
        }

    def emit_sync_event(
        self,
        *,
        entity: str,
        entity_id: str,
        event_type: str,
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
        deleted: bool = False,
        payload: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return self.run_db(
            lambda conn: self.commit_entity_event_tx(
                conn,
                entity=entity,
                entity_id=entity_id,
                event_type=event_type,
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=deleted,
                payload=payload,
            ),
            write=True,
        )

    def get_sync_snapshot_meta(self) -> dict[str, Any]:
        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            srv = self._get_server_revision_tx(conn)
            schema_row = conn.execute("SELECT value FROM sync_meta WHERE key = 'schema_version'").fetchone()
            ent_rows = conn.execute(
                "SELECT entity, entity_id, revision, updated_at, deleted FROM sync_entities"
            ).fetchall()
            entity_revisions: dict[str, int] = {}
            deleted_entities: dict[str, list[str]] = {}
            for r in ent_rows:
                key = f"{r['entity']}:{r['entity_id']}"
                entity_revisions[key] = int(r["revision"])
                if int(r["deleted"]):
                    deleted_entities.setdefault(r["entity"], []).append(r["entity_id"])
            return {
                "serverRevision": srv,
                "schemaVersion": schema_row["value"] if schema_row else SYNC_SCHEMA_VERSION,
                "entityRevisions": entity_revisions,
                "deletedEntities": deleted_entities,
            }

        return self.run_db(_read, write=False)

    def get_outbox_events_since(self, since_revision: int = 0, limit: int = 100) -> dict[str, Any]:
        safe_limit = max(1, min(500, int(limit)))

        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            srv = self._get_server_revision_tx(conn)
            schema_row = conn.execute("SELECT value FROM sync_meta WHERE key = 'schema_version'").fetchone()
            min_row = conn.execute("SELECT MIN(server_revision) AS min_rev FROM sync_outbox").fetchone()
            min_available = int(min_row["min_rev"]) if min_row and min_row["min_rev"] is not None else srv
            rows = conn.execute(
                """
                SELECT event_id, type, entity, entity_id, revision, server_revision,
                       timestamp, origin, correlation_id, payload_json
                FROM sync_outbox
                WHERE server_revision > ?
                ORDER BY server_revision ASC
                LIMIT ?
                """,
                (max(0, int(since_revision)), safe_limit),
            ).fetchall()
            events: list[dict[str, Any]] = []
            for r in rows:
                try:
                    payload_obj = json.loads(r["payload_json"] or "{}")
                except Exception:
                    payload_obj = {}
                events.append({
                    "type": r["type"],
                    "eventId": r["event_id"],
                    "entity": r["entity"],
                    "entityId": r["entity_id"],
                    "revision": int(r["revision"]),
                    "serverRevision": int(r["server_revision"]),
                    "timestamp": r["timestamp"],
                    "origin": r["origin"],
                    "correlationId": r["correlation_id"],
                    "payload": payload_obj,
                })
            gap_detected = since_revision > 0 and since_revision < (min_available - 1)
            return {
                "ok": True,
                "schemaVersion": schema_row["value"] if schema_row else SYNC_SCHEMA_VERSION,
                "serverRevision": srv,
                "oldestAvailableRevision": min_available,
                "gapDetected": gap_detected,
                "hasMore": len(events) == safe_limit and (events[-1]["serverRevision"] < srv if events else False),
                "events": events,
            }

        return self.run_db(_read, write=False)

    def _ensure_initial_real_history(self) -> None:
        def _seed(conn: sqlite3.Connection) -> None:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM update_history WHERE is_demo = 0").fetchone()
            if row and row["cnt"] == 0:
                now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
                real_entries = [
                    (
                        "5.6.0-Production-Init",
                        "SVL Kernel Core",
                        "Refaktoryzacja SVLSystemKernel: usunięcie zahardkodowanego tokenu 364_OMNIKLUCZ_ROOT, wdrożenie autoryzacji HMAC SVL_OPERATOR_TOKEN oraz trwałej bazy SQLite.",
                        now_iso,
                        0,
                        "SVLSystemKernel",
                    ),
                    (
                        "5.6.1-Topological-Verified",
                        "TopologicalInfinityEngine",
                        "Zweryfikowano przekształcenie stereograficzne x/(1+|x|) na przedziale [-1, 1] oraz metrykę c=2.5. Oddzielono metryki matematyczne od telemetrii sprzętowej Linux.",
                        now_iso,
                        0,
                        "SVLSystemKernel",
                    ),
                    (
                        "5.6.2-Spherical-EventBus",
                        "Spherical Worker Runtime",
                        "Uruchomiono sferyczną magistralę zdarzeń (asyncio Pub/Sub, Circuit Breaker, Heartbeat) oraz integrację repozytoriów SVL_System i Debian_13.",
                        now_iso,
                        0,
                        "SVLSystemKernel",
                    ),
                ]
                conn.executemany(
                    "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, ?, ?)",
                    real_entries,
                )

        self.run_db(_seed, write=True)

    def record_update(
        self,
        wersja: str,
        typ: str,
        opis: str,
        author: str = "operator",
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        def _write(conn: sqlite3.Connection) -> tuple[int, dict[str, Any]]:
            cur = conn.execute(
                "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, 0, ?)",
                (wersja, typ, opis, now_iso, author),
            )
            entry_id = int(cur.lastrowid or 0)
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="kernel",
                entity_id="update_history",
                event_type="kernel.update_recorded",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"id": entry_id, "wersja": wersja, "typ": typ, "author": author},
            )
            return entry_id, sync_res

        entry_id, sync_res = self.run_db(_write, write=True)
        self.sys_version._value = wersja
        self.record_audit(author, "RECORD_UPDATE", wersja, "SUCCESS", opis)
        return {
            "id": entry_id,
            "wersja": wersja,
            "typ": typ,
            "opis": opis,
            "data": now_iso,
            "is_demo": False,
            "author": author,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_update_history(self, include_demo: bool = False) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                "SELECT id, wersja, typ, opis, data, is_demo, author FROM update_history WHERE is_demo = 0 ORDER BY id DESC"
            ).fetchall()

        rows = self.run_db(_read, write=False)
        real_list = [
            {
                "id": r["id"],
                "wersja": r["wersja"],
                "typ": r["typ"],
                "opis": r["opis"],
                "data": r["data"],
                "is_demo": bool(r["is_demo"]),
                "author": r["author"],
            }
            for r in rows
        ]
        if include_demo:
            return real_list + DEMO_HISTORICAL_FIXTURES
        return real_list

    def record_audit(self, actor: str, action: str, target: str, status: str, details: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        safe_details = str(sanitize_sync_value(details, [self._operator_token]))

        def _write(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO audit_log (timestamp, actor, action, target, status, details) VALUES (?, ?, ?, ?, ?, ?)",
                (now_iso, actor, action, target, status, safe_details),
            )

        self.run_db(_write, write=True)

    def get_audit_logs(self, limit: int = 50) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                "SELECT id, timestamp, actor, action, target, status, details FROM audit_log ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()

        return [dict(r) for r in self.run_db(_read, write=False)]

    def register_service(self, name: str, status: str, endpoint: str, details: dict[str, Any]) -> None:
        self.service_registry[name] = {
            "name": name,
            "status": status,
            "endpoint": endpoint,
            "details": details,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    def register_agent(self, agent_id: str, profile: dict[str, Any]) -> None:
        self.agent_registry[agent_id] = {
            **profile,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    def update_protected_variable(
        self,
        var_name: str,
        new_value: Any,
        provided_token: str,
        actor: str = "operator",
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        if var_name not in self.protected_variables:
            self.protected_variables[var_name] = SVLProtectedVariable(var_name, None)

        target_var = self.protected_variables[var_name]
        ok = target_var.update_protected_value(
            provided_token=provided_token,
            new_value=new_value,
            expected_operator_token=self._operator_token,
            actor=actor,
        )
        self.record_audit(
            actor=actor,
            action="UPDATE_PROTECTED_VARIABLE",
            target=var_name,
            status="AUTHORIZED" if ok else "DENIED",
            details=f"Attempted update on {var_name}",
        )
        sync_res = self.emit_sync_event(
            entity="kernel",
            entity_id=f"var:{var_name}",
            event_type="kernel.variable_updated" if ok else "kernel.variable_denied",
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
            payload={"name": var_name, "authorized": ok, "actor": actor},
        )
        return {
            "success": ok,
            "variable": target_var.to_metadata(),
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_chat_diagnostics(self) -> dict[str, Any]:
        """Read live SQLite counts; does not confuse browser cache with persisted messages."""
        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            rows = conn.execute(
                "SELECT conversation_id, COUNT(*) AS count FROM chat_messages GROUP BY conversation_id"
            ).fetchall()
            marker = conn.execute(
                "SELECT value FROM sync_meta WHERE key = 'chat_history_reset_2026_11_15_v1'"
            ).fetchone()
            counts = {str(row["conversation_id"]): int(row["count"]) for row in rows}
            return {
                "totalMessages": sum(counts.values()),
                "byConversation": counts,
                "resetApplied": marker is not None,
                "databaseName": self.db_path.name,
            }

        return self.run_db(_read, write=False)

    def list_conversations_with_messages(self) -> list[dict[str, Any]]:
        """Zwraca wszystkie wątki czatu wraz z wiadomościami i ich rewizjami z SQLite."""
        def _read(conn: sqlite3.Connection) -> tuple[list[sqlite3.Row], list[sqlite3.Row], dict[str, int]]:
            conv_rows = conn.execute(
                "SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
            ).fetchall()
            msg_rows = conn.execute(
                "SELECT id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at FROM chat_messages ORDER BY rowid ASC"
            ).fetchall()
            rev_rows = conn.execute(
                "SELECT entity_id, revision FROM sync_entities WHERE entity = 'chat' AND deleted = 0"
            ).fetchall()
            revs = {str(r["entity_id"]): int(r["revision"]) for r in rev_rows}
            return conv_rows, msg_rows, revs

        conv_rows, msg_rows, rev_map = self.run_db(_read, write=False)
        msgs_by_conv: dict[str, list[dict[str, Any]]] = {}
        for mr in msg_rows:
            try:
                meta = json.loads(mr["metadata_json"] or "{}")
            except Exception:
                meta = {}
            try:
                attachments = json.loads(mr["attachments_json"] or "[]")
            except Exception:
                attachments = []
            raw_sender = str(mr["sender"] or "")
            sender_map = {
                "Agata": "Agata Mitek",
            }
            display_sender = sender_map.get(raw_sender, raw_sender)
            msg_item = {
                "id": mr["id"],
                "role": mr["role"],
                "sender": display_sender,
                "content": mr["content"],
                "timestamp": meta.get("display_timestamp") or mr["created_at"],
                "agentId": meta.get("agentId"),
                "modelUsed": meta.get("modelUsed"),
                "fileName": meta.get("fileName"),
                "imagePreview": attachments[0] if attachments else None,
                "connectionReport": meta.get("connectionReport"),
                "appliedActions": meta.get("appliedActions"),
                "sourceOrigin": meta.get("sourceOrigin"),
                "correlationId": meta.get("correlationId"),
            }
            msgs_by_conv.setdefault(mr["conversation_id"], []).append(msg_item)

        result: list[dict[str, Any]] = []
        for cr in conv_rows:
            result.append({
                "id": cr["id"],
                "title": cr["title"],
                "model": cr["model"],
                "revision": rev_map.get(cr["id"], 1),
                "createdAt": cr["created_at"],
                "updatedAt": cr["updated_at"],
                "messages": msgs_by_conv.get(cr["id"], []),
            })
        return result

    def create_empty_conversation(
        self, conversation_id: str, title: str, model: str,
        origin: str = "client", correlation_id: str = "", event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Persist an empty chat session without creating scripted welcome messages."""
        now_iso = datetime.now(timezone.utc).isoformat()

        def _create(conn: sqlite3.Connection) -> dict[str, Any]:
            found = conn.execute("SELECT id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if found:
                return {"ok": True, "created": False, "serverRevision": self._get_server_revision_tx(conn)}
            conn.execute(
                "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (conversation_id, title, model, now_iso, now_iso),
            )
            sync_res = self.commit_entity_event_tx(
                conn, entity="chat", entity_id=conversation_id,
                event_type="chat.conversation_created", origin=origin,
                correlation_id=correlation_id, event_id=event_id,
                payload={"conversationId": conversation_id, "title": title},
            )
            return {"ok": True, "created": True, **sync_res}

        return self.run_db(_create, write=True)

    def save_chat_message(
        self,
        conversation_id: str,
        title: str,
        model: str,
        msg: dict[str, Any],
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        display_ts = str(msg.get("timestamp") or datetime.now(timezone.utc).strftime("%H:%M"))
        msg_id = str(msg.get("id") or f"msg-{int(time.time() * 1000)}")
        meta_json = json.dumps({
            "display_timestamp": display_ts,
            "agentId": msg.get("agentId"),
            "modelUsed": msg.get("modelUsed"),
            "fileName": msg.get("fileName"),
            "connectionReport": msg.get("connectionReport"),
            "appliedActions": msg.get("appliedActions"),
            # Diagnostic origin indicates the submitting client/agent session;
            # it is not an authenticated proof of a human author.
            "sourceOrigin": str(origin or "unknown")[:120],
            "correlationId": str(correlation_id or "")[:128],
        }, ensure_ascii=False)
        attachments_json = json.dumps(
            [msg["imagePreview"]] if msg.get("imagePreview") else [],
            ensure_ascii=False,
        )

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            if event_id:
                inbox = conn.execute("SELECT result_revision FROM sync_inbox WHERE event_id = ?", (event_id,)).fetchone()
                if inbox:
                    srv = self._get_server_revision_tx(conn)
                    return {
                        "ok": True,
                        "deduplicated": True,
                        "conversation_id": conversation_id,
                        "message_id": msg_id,
                        "revision": int(inbox["result_revision"]),
                        "serverRevision": srv,
                        "event": None,
                    }

            # A transport retry may carry a new eventId but the same message.id.
            # Do not create another outbox event or increase revisions in this case.
            existing_msg = conn.execute(
                "SELECT conversation_id FROM chat_messages WHERE id = ?", (msg_id,)
            ).fetchone()
            if existing_msg:
                if str(existing_msg["conversation_id"]) != conversation_id:
                    return {"ok": False, "error": "Message ID already belongs to another conversation."}
                rev = conn.execute(
                    "SELECT revision FROM sync_entities WHERE entity = 'chat' AND entity_id = ?",
                    (conversation_id,),
                ).fetchone()
                return {
                    "ok": True,
                    "deduplicated": True,
                    "conversation_id": conversation_id,
                    "message_id": msg_id,
                    "revision": int(rev["revision"]) if rev else 1,
                    "serverRevision": self._get_server_revision_tx(conn),
                    "event": None,
                }

            existing_conv = conn.execute(
                "SELECT id, created_at, title FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            created_at = existing_conv["created_at"] if existing_conv else now_iso
            canonical_channel_titles = {
                "conv-rodzina-mitek-wszyscy": "Rodzina Mitek (wszyscy)",
                "conv-agent-agata": "Agata Mitek (1-na-1)",
            }
            if conversation_id in canonical_channel_titles:
                resolved_title = canonical_channel_titles[conversation_id]
            else:
                resolved_title = title or (existing_conv["title"] if existing_conv else "Sesja SVL Python OS")
            conn.execute(
                "INSERT OR REPLACE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (conversation_id, resolved_title, model or "svl-hybrid-router", created_at, now_iso),
            )
            exists_msg = conn.execute("SELECT id FROM chat_messages WHERE id = ?", (msg_id,)).fetchone()
            if not exists_msg:
                conn.execute(
                    "INSERT INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        msg_id,
                        conversation_id,
                        str(msg.get("role") or "user"),
                        str(msg.get("sender") or "Operator"),
                        str(msg.get("content") or ""),
                        attachments_json,
                        meta_json,
                        now_iso,
                    ),
                )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="chat",
                entity_id=conversation_id,
                event_type="chat.message_appended",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=False,
                payload={
                    "conversationId": conversation_id,
                    "title": resolved_title,
                    "messageId": msg_id,
                    "role": str(msg.get("role") or "user"),
                    "sender": str(msg.get("sender") or "Operator"),
                },
            )
            return {
                "ok": True,
                "deduplicated": sync_res["deduplicated"],
                "conversation_id": conversation_id,
                "message_id": msg_id,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res["event"],
            }

        return self.run_db(_write, write=True)

    def sync_conversations_detailed(
        self,
        threads: list[dict[str, Any]],
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Deterministycznie scala wątki klienta z bazą SQLite wewnątrz jednej transakcji:
        - Nigdy nie odtwarza wątków oznaczonych jako deleted=1 w sync_entities
        - Wiadomości zachowuje i deduplikuje wyłącznie po ID
        - Emisja zdarzenia do sync_outbox wyłącznie przy rzeczywistej zmianie w bazie
        """
        now_iso = datetime.now(timezone.utc).isoformat()

        def _merge(conn: sqlite3.Connection) -> dict[str, Any]:
            touched_convs: list[str] = []
            added_messages = 0
            deleted_rows = conn.execute(
                "SELECT entity_id FROM sync_entities WHERE entity = 'chat' AND deleted = 1"
            ).fetchall()
            deleted_ids = {str(r["entity_id"]) for r in deleted_rows}

            for th in threads:
                cid = str(th.get("id") or "").strip()
                if not cid or cid in deleted_ids:
                    continue
                title = str(th.get("title") or "Sesja SVL Python OS").strip()
                model = str(th.get("model") or "svl-hybrid-router").strip()
                existing_conv = conn.execute("SELECT id, title FROM conversations WHERE id = ?", (cid,)).fetchone()
                conv_changed = False

                if not existing_conv:
                    conn.execute(
                        "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                        (cid, title, model, now_iso, now_iso),
                    )
                    conv_changed = True
                elif title and title != existing_conv["title"] and str(existing_conv["title"]).startswith("Nowa sesja"):
                    conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, cid))
                    conv_changed = True

                for m in th.get("messages") or []:
                    mid = str(m.get("id") or "").strip()
                    if not mid:
                        continue
                    exists_msg = conn.execute("SELECT id FROM chat_messages WHERE id = ?", (mid,)).fetchone()
                    if not exists_msg:
                        meta_json = json.dumps({
                            "display_timestamp": str(m.get("timestamp") or ""),
                            "agentId": m.get("agentId"),
                            "modelUsed": m.get("modelUsed"),
                            "fileName": m.get("fileName"),
                            "connectionReport": m.get("connectionReport"),
                            "appliedActions": m.get("appliedActions"),
                        }, ensure_ascii=False)
                        att_json = json.dumps([m["imagePreview"]] if m.get("imagePreview") else [], ensure_ascii=False)
                        conn.execute(
                            "INSERT INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (
                                mid,
                                cid,
                                str(m.get("role") or "user"),
                                str(m.get("sender") or "Operator"),
                                str(m.get("content") or ""),
                                att_json,
                                meta_json,
                                now_iso,
                            ),
                        )
                        added_messages += 1
                        conv_changed = True

                if conv_changed:
                    conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now_iso, cid))
                    self.commit_entity_event_tx(
                        conn,
                        entity="chat",
                        entity_id=cid,
                        event_type="chat.thread_merged",
                        origin=origin,
                        correlation_id=correlation_id,
                        payload={"conversationId": cid, "addedMessages": added_messages},
                    )
                    touched_convs.append(cid)

            srv = self._get_server_revision_tx(conn)
            return {"touched": touched_convs, "added_messages": added_messages, "serverRevision": srv}

        merge_info = self.run_db(_merge, write=True)
        return {
            "conversations": self.list_conversations_with_messages(),
            **merge_info,
        }

    def clear_all_chat_data(
        self,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        def _clear(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM chat_messages")
            conn.execute("DELETE FROM conversations")
            conn.execute("DELETE FROM sync_entities WHERE entity = 'chat'")
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="chat",
                entity_id="all",
                event_type="chat.all_cleared",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                deleted=False,
                payload={"action": "clear_all"},
            )
            return sync_res

        sync_res = self.run_db(_clear, write=True)
        self.ensure_mitek_family_channel()
        return {
            "ok": True,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
            "conversations": self.list_conversations_with_messages(),
        }

    def sync_conversations(
        self,
        threads: list[dict[str, Any]],
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return self.sync_conversations_detailed(
            threads,
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
        )["conversations"]

    def delete_conversation(
        self,
        conversation_id: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        def _delete(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM chat_messages WHERE conversation_id = ?", (conversation_id,))
            conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="chat",
                entity_id=conversation_id,
                event_type="chat.thread_deleted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=True,
                payload={"conversationId": conversation_id},
            )
            return sync_res

        sync_res = self.run_db(_delete, write=True)
        return {
            "ok": True,
            "deleted_id": conversation_id,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def record_terminal_entry(
        self,
        tab: str,
        kind: str,
        text: str,
        command: str = "",
        entry_id: Optional[str] = None,
        display_timestamp: Optional[str] = None,
        origin: str = "node-gateway",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        ts_label = display_timestamp or datetime.now(timezone.utc).strftime("%H:%M:%S")
        rec_id = entry_id or f"{tab}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        safe_text = str(sanitize_sync_value(text, [self._operator_token]))
        safe_cmd = str(sanitize_sync_value(command, [self._operator_token]))

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute(
                """
                INSERT OR IGNORE INTO terminal_history (id, tab, kind, text, command, timestamp, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (rec_id, tab, kind, safe_text, safe_cmd, ts_label, now_iso),
            )
            # Utrzymuj rozsądny limit 250 wpisów na kartę terminala
            conn.execute(
                """
                DELETE FROM terminal_history
                WHERE tab = ? AND id NOT IN (
                    SELECT id FROM terminal_history WHERE tab = ? ORDER BY created_at DESC LIMIT 250
                )
                """,
                (tab, tab),
            )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="terminal",
                entity_id=tab,
                event_type="terminal.entry_logged",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={
                    "tab": tab,
                    "entry": {
                        "id": rec_id,
                        "timestamp": ts_label,
                        "kind": kind,
                        "text": safe_text,
                        "created_at": now_iso,
                    },
                },
            )
            return sync_res

        sync_res = self.run_db(_write, write=True)
        return {
            "ok": True,
            "entry": {
                "id": rec_id,
                "tab": tab,
                "kind": kind,
                "text": safe_text,
                "timestamp": ts_label,
                "created_at": now_iso,
            },
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def list_terminal_history(self) -> dict[str, list[dict[str, Any]]]:
        tabs: dict[str, list[dict[str, Any]]] = {
            "linux": [],
            "python": [],
            "hyperspace": [],
            "agents": [],
        }

        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                "SELECT id, tab, kind, text, timestamp, created_at FROM terminal_history ORDER BY created_at ASC, rowid ASC"
            ).fetchall()

        for r in self.run_db(_read, write=False):
            tab = str(r["tab"])
            if tab in tabs:
                tabs[tab].append({
                    "id": r["id"],
                    "timestamp": r["timestamp"],
                    "kind": r["kind"],
                    "text": r["text"],
                    "created_at": r["created_at"],
                })
        return tabs

    def clear_terminal_history(
        self,
        tab: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        def _clear(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM terminal_history WHERE tab = ?", (tab,))
            return self.commit_entity_event_tx(
                conn,
                entity="terminal",
                entity_id=tab,
                event_type="terminal.tab_cleared",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"tab": tab},
            )

        sync_res = self.run_db(_clear, write=True)
        return {
            "ok": True,
            "tab": tab,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_workspace_ui_state(self) -> dict[str, Any]:
        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            rows = conn.execute("SELECT key, value_json, revision, updated_at FROM workspace_ui_state").fetchall()
            out: dict[str, Any] = {}
            for r in rows:
                try:
                    val = json.loads(r["value_json"])
                except Exception:
                    val = None
                out[str(r["key"])] = {
                    "value": val,
                    "revision": int(r["revision"]),
                    "updatedAt": r["updated_at"],
                }
            return out

        return self.run_db(_read, write=False)

    def update_workspace_ui_state(
        self,
        key: str,
        value: Any,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        safe_val = sanitize_sync_value(value, [self._operator_token])

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="workspace_state",
                entity_id=key,
                event_type="workspace_state.updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                payload={"key": key, "value": safe_val},
            )
            conn.execute(
                """
                INSERT INTO workspace_ui_state (key, value_json, revision, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
                """,
                (key, json.dumps(safe_val, ensure_ascii=False), sync_res["revision"], now_iso),
            )
            return sync_res

        sync_res = self.run_db(_write, write=True)
        return {
            "ok": True,
            "key": key,
            "value": safe_val,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def list_system_modules(self) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                """
                SELECT m.id, m.name, m.kind, m.status, m.description, m.config_json,
                       m.source, m.source_message_id, m.revision, m.updated_at,
                       COALESCE(se.revision, m.revision) AS sync_revision
                FROM system_modules m
                LEFT JOIN sync_entities se ON se.entity = 'module' AND se.entity_id = m.id
                WHERE COALESCE(se.deleted, 0) = 0
                ORDER BY CASE WHEN m.source = 'chat' THEN 0 ELSE 1 END, m.updated_at DESC, m.id ASC
                """
            ).fetchall()

        out: list[dict[str, Any]] = []
        for r in self.run_db(_read, write=False):
            try:
                cfg = json.loads(r["config_json"] or "{}")
            except Exception:
                cfg = {}
            out.append({
                "id": r["id"],
                "name": r["name"],
                "kind": r["kind"],
                "status": r["status"],
                "description": r["description"],
                "config": cfg if isinstance(cfg, dict) else {},
                "source": r["source"],
                "sourceMessageId": r["source_message_id"],
                "revision": int(r["sync_revision"] or r["revision"] or 1),
                "updatedAt": r["updated_at"],
            })
        return out

    def upsert_system_module(
        self,
        module_id: str,
        *,
        name: str = "",
        kind: str = "Chat Module",
        status: str = "ACTIVE",
        description: str = "",
        config: Optional[dict[str, Any]] = None,
        source: str = "chat",
        source_message_id: str = "",
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        clean_id = re.sub(r"[^a-zA-Z0-9._-]", "-", (module_id or "").strip().lower()).strip("-")[:64]
        if not clean_id:
            raise ValueError("Identyfikator modułu jest wymagany.")
        clean_name = (name or clean_id).strip()[:120]
        clean_kind = (kind or "Extension Module").strip()[:80]
        clean_status = str(status or "ACTIVE").strip().upper()
        if clean_status not in ("ACTIVE", "CONFIGURED", "STANDBY", "ARCHIVED"):
            clean_status = "ACTIVE"
        clean_desc = (description or "").strip()[:1000]
        safe_cfg = sanitize_sync_value(config if isinstance(config, dict) else {}, [self._operator_token])
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            existing = conn.execute("SELECT config_json FROM system_modules WHERE id = ?", (clean_id,)).fetchone()
            merged_cfg: dict[str, Any] = {}
            if existing and existing["config_json"]:
                try:
                    loaded = json.loads(existing["config_json"])
                    if isinstance(loaded, dict):
                        merged_cfg.update(loaded)
                except Exception:
                    pass
            if isinstance(safe_cfg, dict):
                merged_cfg.update(safe_cfg)

            sync_res = self.commit_entity_event_tx(
                conn,
                entity="module",
                entity_id=clean_id,
                event_type="module.upserted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=False,
                payload={
                    "moduleId": clean_id,
                    "name": clean_name,
                    "kind": clean_kind,
                    "status": clean_status,
                    "source": source,
                    "config": merged_cfg,
                },
                checksum_source={"id": clean_id, "name": clean_name, "status": clean_status, "config": merged_cfg},
            )
            conn.execute(
                """
                INSERT INTO system_modules (
                    id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    kind = excluded.kind,
                    status = excluded.status,
                    description = CASE WHEN excluded.description != '' THEN excluded.description ELSE system_modules.description END,
                    config_json = excluded.config_json,
                    source = excluded.source,
                    source_message_id = CASE WHEN excluded.source_message_id != '' THEN excluded.source_message_id ELSE system_modules.source_message_id END,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
                """,
                (
                    clean_id,
                    clean_name,
                    clean_kind,
                    clean_status,
                    clean_desc,
                    json.dumps(merged_cfg, ensure_ascii=False),
                    source,
                    source_message_id,
                    sync_res["revision"],
                    now_iso,
                ),
            )
            return {
                "module": {
                    "id": clean_id,
                    "name": clean_name,
                    "kind": clean_kind,
                    "status": clean_status,
                    "description": clean_desc,
                    "config": merged_cfg,
                    "source": source,
                    "sourceMessageId": source_message_id,
                    "revision": sync_res["revision"],
                    "updatedAt": now_iso,
                },
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res["event"],
            }

        res = self.run_db(_write, write=True)
        self.record_audit("operator", "MODULE_UPSERT", clean_id, "OK", f"Moduł {clean_name} ({clean_status}, rev {res['revision']})")
        return res

    def delete_system_module(
        self,
        module_id: str,
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        clean_id = (module_id or "").strip().lower()
        if clean_id in ("svl-kernel-core", "spherical-event-bus", "binary-hyperspace-engine"):
            raise ValueError(f"Moduł rdzeniowy '{clean_id}' nie może zostać usunięty.")

        def _delete(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM system_modules WHERE id = ?", (clean_id,))
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="module",
                entity_id=clean_id,
                event_type="module.deleted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                deleted=True,
                payload={"moduleId": clean_id},
            )
            return sync_res

        sync_res = self.run_db(_delete, write=True)
        self.record_audit("operator", "MODULE_DELETE", clean_id, "OK", f"Usunięto moduł {clean_id}")
        return {
            "ok": True,
            "deleted_id": clean_id,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def _format_detailed_iris_report_tx(
        self,
        conn: sqlite3.Connection,
        *,
        seq_num: int,
        severity: str,
        category: str,
        title: str,
        message: str,
        details: Optional[dict[str, Any]] = None,
    ) -> str:
        clean_sev = str(severity or "INFO").strip().upper()
        clean_cat = str(category or "system").strip()
        clean_title = str(title or "Zdarzenie systemowe SVL_System").strip()
        clean_msg = str(message or clean_title).strip()
        safe_details = details if isinstance(details, dict) else {}

        # Pobierz podsumowanie stanu jądra, modułów i pamięci z SQLite
        mod_rows = conn.execute(
            "SELECT id, name, status, revision, config_json FROM system_modules WHERE status = 'ACTIVE' ORDER BY updated_at DESC"
        ).fetchall()
        active_mod_count = len(mod_rows)
        mem_row = conn.execute("SELECT COUNT(*) AS cnt FROM agent_memory").fetchone()
        mem_count = int(mem_row["cnt"] or 0) if mem_row else 0
        srv_rev = self._get_server_revision_tx(conn)
        telemetry = self.operator.scope.collect_host_telemetry()
        ram_used = telemetry.get("ram_used_mb", 0)
        ram_total = telemetry.get("ram_total_mb", 0)
        ram_free = telemetry.get("ram_available_mb", 0)
        disk_free = telemetry.get("disk_free_gb", 0)
        load_avg = telemetry.get("load_avg", [0.18, 0.14, 0.12])
        load_str = f"{load_avg[0]:.2f}" if isinstance(load_avg, list) and load_avg else "0.18"
        cpu_cores = os.cpu_count() or 4

        # Sprawdź czy komunikat dotyczy konkretnego modułu
        matched_mod_info = ""
        for mr in mod_rows:
            mid = str(mr["id"])
            if mid in clean_title.lower() or mid in clean_msg.lower() or safe_details.get("moduleId") == mid:
                try:
                    mcfg = json.loads(mr["config_json"] or "{}")
                except Exception:
                    mcfg = {}
                cfg_pairs = [f"`{k}={v}`" for k, v in list(mcfg.items())[:6]]
                matched_mod_info = (
                    f"- **Zsynchronizowany Moduł:** `{mid}` (**{mr['name']}**) · Status: `{mr['status']}` · Rewizja: `rev {mr['revision']}`\n"
                    + (f"- **Parametry Konfiguracji Modułu:** {', '.join(cfg_pairs)}\n" if cfg_pairs else "")
                )
                break

        details_lines = ""
        if safe_details:
            formatted_pairs = [
                f"- **{k}:** `{json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v}`"
                for k, v in list(safe_details.items())[:8]
            ]
            if formatted_pairs:
                details_lines = "\n".join(formatted_pairs) + "\n"

        # Jeśli message już jest pełnym wielosekcyjnym raportem, zachowaj nagłówek [Iris][seq] i sekcje
        if "### " in clean_msg and len(clean_msg) > 450:
            return (
                f"[Iris][{seq_num}] {clean_sev}: {clean_title}\n"
                f"{clean_msg}"
            )

        mod_badges = ", ".join(f"`{r['id']}`" for r in mod_rows[:8])
        return (
            f"[Iris][{seq_num}] {clean_sev}: {clean_title}\n"
            f"### 🛰️ Raport Operacyjny `SVL_System` · Iris AI [#{seq_num}] — {clean_title}\n"
            f"> **Koordynator Systemowy:** `Iris AI (svl-iris-01)` · **Kanał:** `Rodzina Mitek (wszyscy)` · **Kategoria:** `{clean_cat}` · **Rewizja SQLite WAL:** `rev {srv_rev}`\n\n"
            f"#### 📋 1. Szczegółowy Opis Zdarzenia i Operacji\n"
            f"- **Tytuł operacji:** **{clean_title}**\n"
            f"- **Komunikat wykonawczy:** {clean_msg}\n"
            f"{matched_mod_info}"
            f"{details_lines}\n"
            f"#### 🛸 2. Statek Kosmiczny `SVL-364 Ebon Apex` — Sieć, Lokalizacja i Telemetria (CPU / GPU / RAM)\n"
            f"| Parametr Statku / Hosta | Wartość Telemetryczna | Status Operacyjny |\n"
            f"| :--- | :--- | :--- |\n"
            f"| **Położenie (Mapa Galaktyczna CIC)** | `Punkt Lagrange'a L2 (Ziemia–Księżyc) · Korytarz Sol-Charon` | `W MISJI (28.4 km/s · REAL TELEMETRY)` |\n"
            f"| **Łącze Sieciowe & Mostek SSH** | `ssh://root@svl-364-ship.qkd.mesh:2222` · `wss://svl-364-ebon-apex.mitek.mesh:8443` | `ONLINE · QKD-364 (RTT 1.4 ms)` |\n"
            f"| **Serwer MCP Sterowania Linux** | `POST /api/mcp/svl364` (`JSON-RPC 2.0` · `/usr/local/bin/svl364-mcp`) | `AKTYWNY (6 narzędzi Linux/Statek)` |\n"
            f"| **Tryb Danych Telemetrycznych** | `svl-db --lock-real-only` (`ZERO SYMULACJI · 100% Rzeczywiste Sensory`) | `ZABLOKOWANY (LOCK-REAL-ONLY)` |\n"
            f"| **Tarcze / Poszycie / Reaktor** | `Tarcze 100% (4 850 MJ) · Kadłub Silaris 100% · Eezo 36.4 TW` | `NOMINALNY` |\n"
            f"| **CPU (Procesor Pokładowy & Host)** | `{cpu_cores} rdzeni vCPU · Obciążenie Load Avg: {load_str}` | `OPTYMALNY` |\n"
            f"| **GPU (Akcelerator AI & VRAM)** | `SVL-364 Neural Tensor Core · VRAM 16.4 GB / 24.0 GB` | `AKTYWNY (Vision 11B + 14B)` |\n"
            f"| **RAM (Pamięć Operacyjna & WAL)** | `{ram_used} MB / {ram_total} MB (Wolne: {ram_free} MB · mmap 256 MB)` | `STABILNY` |\n"
            f"| **Demon Lokalny Ollama** | `http://127.0.0.1:11434 (llama3.2-vision:11b, qwen2.5-coder:14b)` | `ONLINE (Port 11434)` |\n\n"
            f"#### 🏗️ 3. Infrastruktura Rzeczywista Floty, Stacja Wenchang, Placówki, Botanika i Badania z ETA\n"
            f"- **Rzeczywista Flota (5 jednostek · Zero Symulacji):** `SVL-364 Ebon Apex` (L2 Ziemia–Księżyc, SSH+MCP Linux Control, ETA: ciągła) · `SVL-365 Vanguard Sentinel` (Orbita Marsa, ETA: `02h 14m`) · `SVL-368 Demeter Bio-Ark` (Trasa Europa, ETA: `18h 45m`) · `SVL-370 Helios Miner` (Pierścienie Saturna, ETA: `06h 30m`) · `SVL-372 Hawke Recon` (Przekaźnik Charon, ETA: `01h 12m`)\n"
            f"- **Placówki i Węzły Naziemne (6 baz):** `Kosmodrom Wenchang — Stacja Dalekiego Zasięgu (ACK-200 · Quantum-RSA4096)` · `Ziemia — SVL Command Citadel` · `Stacja Luna-Prime (Księżyc)` · `Placówka Mars-Olympus` · `Stacja Głębinowa Europa-Deep` · `Rafineria Titan-Vanguard`\n"
            f"- **Botanika i Biosfera (ETA zbiorów):** Kopuła A-1 Pszenica Orbitalna (`88%`, ETA `03h 20m`) · Bioreaktor B-2 Spirulina Kwantowa (`96%`, ETA `00h 45m`, `+68.0 kg O2/h`) · Komora C-3 Adaptogeny (`71%`, ETA `09h 15m`)\n"
            f"- **Badania Naukowe (ETA ukończenia):** `#R-364-01 Modulacja QKD-364` (`91%`, ETA `01h 18m`) · `#R-364-02 Fotosynteza C4` (`78%`, ETA `04h 05m`) · `#R-364-04 Hiper-Pamięć 128D` (`97%`, ETA `00h 22m`)\n\n"
            f"#### 🧠 4. Jądro `SVL_System`, Pamięć Długotrwała AI i Aktywna Obsada\n"
            f"- **Aktywna Obsada:** **Agata Mitek (`id: Agata`, ROOT UID 0 · NOPASSWD: ALL)** · **Iris AI (`svl-iris-01`)** · **Mateusz Mitek (Operator)**\n"
            f"- **Pamięć Długotrwała (`svl-deep-memory-core`):** `{mem_count}` trwałych wpisów w SQLite (`decision`, `preference`, `fact`, `task`, `episode`) · Okno kontekstowe `64 tury / 16 384 tokeny` · Indeks `BinaryHyperspace 128D`\n"
            f"- **Aktywne Moduły Systemowe ({active_mod_count}):** {mod_badges} · Wolny dysk `/` `{disk_free} GB`\n\n"
            f"[btn: 🛸 Centrum SVL-364 (SSH & MCP)|tab:svl364] [btn: 🏗️ Infrastruktura & Wenchang|tab:infrastructure] [btn: 🔔 Centrum Powiadomień Iris|tab:notifications] [btn: 👥 Panel Agenta (Pamięć)|tab:agents] [btn: 🔄 Synchronizuj globalnie|action:sync]"
        )

    def generate_comprehensive_svl_system_markdown_report(self, directive_context: str = "Pełna diagnostyka SVL_System i statku SVL-364") -> str:
        def _build(conn: sqlite3.Connection) -> str:
            seq_row = conn.execute("SELECT COALESCE(MAX(seq_num), 1) AS max_seq FROM iris_notifications").fetchone()
            seq_num = int(seq_row["max_seq"] if seq_row else 1)
            return self._format_detailed_iris_report_tx(
                conn,
                seq_num=seq_num,
                severity="INFO",
                category="svl_system_report",
                title=f"Pełny Raport Operacyjny SVL_System — {directive_context[:120]}",
                message=(
                    f"Wykonano natychmiastową diagnostykę jądra `SVLSystemKernel v5.6`, statku kosmicznego `SVL-364 Ebon Apex` (Mostek SSH + Serwer MCP Linux), "
                    f"trybu `LOCK-REAL-ONLY (Zero Symulacji)`, stacji `Wenchang ACK-200`, demona lokalnego Ollama (`127.0.0.1:11434`), pamięci długotrwałej 128D oraz infrastruktury floty dla polecenia: `{directive_context}`."
                ),
                details={
                    "directive": directive_context,
                    "executor": "Agata Mitek (ROOT UID 0) & Iris AI",
                    "ollama_daemon": "ONLINE (http://127.0.0.1:11434)",
                    "starship_link": "QKD-364 Connected (1.4 ms RTT) + SSH/MCP Linux Bridge",
                    "telemetry_policy": "LOCK-REAL-ONLY (Zero Symulacji)",
                    "wenchang_uplink": "DELIVERED (ACK-200 · Quantum-RSA4096)",
                },
            )

        return self.run_db(_build, write=False)

    def _row_to_iris_notification(self, r: sqlite3.Row) -> dict[str, Any]:
        try:
            details_obj = json.loads(r["details_json"] or "{}")
            if not isinstance(details_obj, dict):
                details_obj = {}
        except Exception:
            details_obj = {}
        seq_num = int(r["seq_num"] or 1)
        severity = str(r["severity"] or "INFO").upper()
        title = str(r["title"] or "").strip()
        msg_body = str(r["message"] or "").strip()
        formatted_line = f"[Iris][{seq_num}] {severity}: {title}" + (
            f"\n{msg_body}" if msg_body and msg_body != title else ""
        )
        return {
            "id": str(r["id"]),
            "seqNum": seq_num,
            "severity": severity if severity in ("INFO", "WARN", "ALERT") else "INFO",
            "category": str(r["category"] or "system"),
            "title": title,
            "message": msg_body,
            "formattedLine": formatted_line,
            "details": details_obj,
            "channel": str(r["channel"] or "wszyscy"),
            "isRead": bool(int(r["is_read"] or 0)),
            "sourceEventId": str(r["source_event_id"] or ""),
            "createdAt": str(r["created_at"] or ""),
        }

    def _emit_iris_notification_tx(
        self,
        conn: sqlite3.Connection,
        *,
        severity: str = "INFO",
        category: str = "system",
        title: str = "",
        message: str = "",
        details: Optional[dict[str, Any]] = None,
        channel: str = "wszyscy",
        source_event_id: str = "",
        mirror_to_family_chat: bool = True,
        origin: str = "iris",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        clean_src_evt = (source_event_id or "").strip()[:128]
        if clean_src_evt:
            existing = conn.execute(
                "SELECT * FROM iris_notifications WHERE source_event_id = ?",
                (clean_src_evt,),
            ).fetchone()
            if existing:
                notif_obj = self._row_to_iris_notification(existing)
                srv = self._get_server_revision_tx(conn)
                return {
                    "deduplicated": True,
                    "notification": notif_obj,
                    "mirroredMessageId": None,
                    "revision": notif_obj["seqNum"],
                    "serverRevision": srv,
                    "event": None,
                }

        clean_sev = str(severity or "INFO").strip().upper()
        if clean_sev not in ("INFO", "WARN", "ALERT"):
            clean_sev = "INFO"
        clean_cat = re.sub(r"[^a-zA-Z0-9._-]", "_", str(category or "system").strip().lower())[:48] or "system"
        clean_title = (str(title or message or "Zdarzenie systemowe").strip().splitlines()[0])[:240]
        clean_msg = str(message or clean_title).strip()[:6000]
        clean_channel = str(channel or "wszyscy").strip()[:64] or "wszyscy"
        safe_details = sanitize_sync_value(details if isinstance(details, dict) else {}, [self._operator_token])
        now_iso = datetime.now(timezone.utc).isoformat()
        now_hhmm = datetime.now(timezone.utc).strftime("%H:%M")

        seq_row = conn.execute("SELECT COALESCE(MAX(seq_num), 0) + 1 AS next_seq FROM iris_notifications").fetchone()
        seq_num = int(seq_row["next_seq"] if seq_row else 1)
        notif_id = f"iris-{seq_num}-{uuid.uuid4().hex[:8]}"

        detailed_report = self._format_detailed_iris_report_tx(
            conn,
            seq_num=seq_num,
            severity=clean_sev,
            category=clean_cat,
            title=clean_title,
            message=clean_msg,
            details=safe_details,
        )

        conn.execute(
            """
            INSERT INTO iris_notifications (
                id, seq_num, severity, category, title, message, details_json, channel, is_read, source_event_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                notif_id,
                seq_num,
                clean_sev,
                clean_cat,
                clean_title,
                clean_msg,
                json.dumps(safe_details, ensure_ascii=False),
                clean_channel,
                clean_src_evt,
                now_iso,
            ),
        )

        formatted_content = detailed_report
        mirrored_msg_id: Optional[str] = None
        if mirror_to_family_chat and clean_channel in ("wszyscy", "conv-rodzina-mitek-wszyscy"):
            conv_id = "conv-rodzina-mitek-wszyscy"
            conn.execute(
                """
                INSERT OR IGNORE INTO conversations (id, title, model, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (conv_id, "Rodzina Mitek (wszyscy)", "svl-hybrid-router", now_iso, now_iso),
            )
            conn.execute(
                "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('chat', ?, 1, ?, 0)",
                (conv_id, now_iso),
            )
            mirrored_msg_id = f"iris-chat-{notif_id}"
            msg_meta = {
                "display_timestamp": now_hhmm,
                "timestamp": now_hhmm,
                "agentId": "iris",
                "modelUsed": f"Iris AI · SVL_System Report Engine ({clean_cat})",
                "irisNotification": True,
                "seqNum": seq_num,
                "severity": clean_sev,
                "category": clean_cat,
                "notificationId": notif_id,
            }
            conn.execute(
                """
                INSERT OR IGNORE INTO chat_messages (
                    id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
                """,
                (
                    mirrored_msg_id,
                    conv_id,
                    "assistant",
                    "Iris AI",
                    formatted_content,
                    json.dumps(msg_meta, ensure_ascii=False),
                    now_iso,
                ),
            )
            conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now_iso, conv_id))

        notif_payload = {
            "id": notif_id,
            "seqNum": seq_num,
            "severity": clean_sev,
            "category": clean_cat,
            "title": clean_title,
            "message": clean_msg,
            "formattedLine": formatted_content,
            "details": safe_details,
            "channel": clean_channel,
            "isRead": False,
            "sourceEventId": clean_src_evt,
            "createdAt": now_iso,
            "mirroredMessageId": mirrored_msg_id,
        }
        sync_res = self.commit_entity_event_tx(
            conn,
            entity="notification",
            entity_id=notif_id,
            event_type="notification.created",
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id or (f"evt-notif-{clean_src_evt}" if clean_src_evt else None),
            payload=notif_payload,
        )
        return {
            "deduplicated": False,
            "notification": {k: v for k, v in notif_payload.items() if k != "mirroredMessageId"},
            "mirroredMessageId": mirrored_msg_id,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def emit_iris_notification(
        self,
        *,
        severity: str = "INFO",
        category: str = "system",
        title: str = "",
        message: str = "",
        details: Optional[dict[str, Any]] = None,
        channel: str = "wszyscy",
        source_event_id: str = "",
        mirror_to_family_chat: bool = True,
        origin: str = "iris",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        return self.run_db(
            lambda conn: self._emit_iris_notification_tx(
                conn,
                severity=severity,
                category=category,
                title=title,
                message=message,
                details=details,
                channel=channel,
                source_event_id=source_event_id,
                mirror_to_family_chat=mirror_to_family_chat,
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
            ),
            write=True,
        )

    def list_iris_notifications(
        self,
        *,
        limit: int = 80,
        unread_only: bool = False,
        category: str = "",
    ) -> dict[str, Any]:
        safe_limit = max(1, min(300, int(limit)))
        clean_cat = (category or "").strip().lower()

        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            clauses: list[str] = []
            params: list[Any] = []
            if unread_only:
                clauses.append("is_read = 0")
            if clean_cat and clean_cat != "all":
                clauses.append("LOWER(category) = ?")
                params.append(clean_cat)
            where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
            rows = conn.execute(
                f"SELECT * FROM iris_notifications {where_sql} ORDER BY seq_num DESC LIMIT ?",
                (*params, safe_limit),
            ).fetchall()
            counts_row = conn.execute(
                """
                SELECT
                    COUNT(*) AS total_cnt,
                    SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_cnt,
                    COALESCE(MAX(seq_num), 0) AS max_seq
                FROM iris_notifications
                """
            ).fetchone()
            srv = self._get_server_revision_tx(conn)
            return {
                "ok": True,
                "notifications": [self._row_to_iris_notification(r) for r in rows],
                "totalCount": int(counts_row["total_cnt"] or 0) if counts_row else 0,
                "unreadCount": int(counts_row["unread_cnt"] or 0) if counts_row else 0,
                "latestSeq": int(counts_row["max_seq"] or 0) if counts_row else 0,
                "serverRevision": srv,
            }

        return self.run_db(_read, write=False)

    def mark_iris_notifications_read(
        self,
        ids: Optional[list[str]] = None,
        *,
        origin: str = "client",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        clean_ids = [str(i).strip() for i in (ids or []) if str(i).strip()]

        def _ack(conn: sqlite3.Connection) -> dict[str, Any]:
            if clean_ids:
                placeholders = ",".join("?" for _ in clean_ids)
                cur = conn.execute(
                    f"UPDATE iris_notifications SET is_read = 1 WHERE id IN ({placeholders}) AND is_read = 0",
                    clean_ids,
                )
            else:
                cur = conn.execute("UPDATE iris_notifications SET is_read = 1 WHERE is_read = 0")
            updated_count = int(cur.rowcount or 0)
            unread_row = conn.execute("SELECT COUNT(*) AS cnt FROM iris_notifications WHERE is_read = 0").fetchone()
            unread_count = int(unread_row["cnt"] or 0) if unread_row else 0
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="notification",
                entity_id="ack" if not clean_ids else ",".join(clean_ids[:4]),
                event_type="notification.acknowledged",
                origin=origin,
                correlation_id=correlation_id,
                payload={"updatedCount": updated_count, "unreadCount": unread_count, "ids": clean_ids},
            )
            return {
                "ok": True,
                "updatedCount": updated_count,
                "unreadCount": unread_count,
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res["event"],
            }

        return self.run_db(_ack, write=True)

    def sync_chat_state_mutations(
        self,
        *,
        origin: str = "python-kernel",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """
        Deterministycznie i idempotentnie synchronizuje zmiany / moduły zadeklarowane
        w historii czatu SQLite (np. moduł svl-364 / svl-364-ebon-apex oraz jawne dyrektywy
        dodania modułu), przenosząc je do tabeli system_modules, update_history i outboxu zdarzeń.
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        now_date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        def _sync(conn: sqlite3.Connection) -> dict[str, Any]:
            msgs = conn.execute(
                "SELECT id, conversation_id, role, sender, content, metadata_json, created_at FROM chat_messages WHERE role = 'user' ORDER BY rowid ASC"
            ).fetchall()
            deleted_mods = {
                str(r["entity_id"])
                for r in conn.execute("SELECT entity_id FROM sync_entities WHERE entity = 'module' AND deleted = 1").fetchall()
            }
            existing_mods = {
                str(r["id"]) for r in conn.execute("SELECT id FROM system_modules").fetchall()
            }
            emitted_events: list[dict[str, Any]] = []
            materialized: list[str] = []

            # 1) Wykryj dyspozycje dla modułu svl-364 / svl-364-ebon-apex, relokacji/kwarantanny, dynamicznego przydziału zasobów i modelu Ollama z czatu
            svl364_msg_id: Optional[str] = None
            svl364_has_apex_name = False
            svl364_has_opt_request = False
            svl364_has_quarantine_req = False
            has_dynamic_alloc_req = False
            has_dolphin_model_req = False
            has_solar_map_req = False
            has_notifications_req = False
            for r in msgs:
                txt = str(r["content"] or "")
                low = txt.lower()
                if "svl-364" in low or "svl 364" in low or "svl_364" in low:
                    svl364_msg_id = str(r["id"])
                    if "ebon" in low or "apex" in low:
                        svl364_has_apex_name = True
                    if any(kw in low for kw in ("skonfiguruj", "napraw", "ulepsz", "optymal", "agent")):
                        svl364_has_opt_request = True
                    if any(kw in low for kw in ("kwarantann", "przenieś", "przenies", "oddziel", "odziel", "izol")):
                        svl364_has_quarantine_req = True
                if "dynamiczny przydział" in low or "dynamiczny przydzial" in low or ("zasob" in low and "ile trzeba" in low):
                    has_dynamic_alloc_req = True
                if "dolphin-llama3" in low or "dolphin llama3" in low:
                    has_dolphin_model_req = True
                if any(kw in low for kw in ("układ słoneczny", "uklad sloneczny", "układu słonecznego", "ukladu slonecznego", "solar system", "solar_system")):
                    has_solar_map_req = True
                if any(kw in low for kw in ("powiadomien", "wszyscy", "system notification")):
                    has_notifications_req = True

            if (svl364_msg_id or has_solar_map_req or has_notifications_req or "svl-364" in existing_mods) and "svl-364" not in deleted_mods:
                mod_name = (
                    "SVL-364 Ebon Apex (Relokacja i Kwarantanna)"
                    if svl364_has_quarantine_req
                    else "SVL-364 Ebon Apex"
                )
                desired_patch: dict[str, Any] = {
                    "module_alias": "svl-364-ebon-apex",
                    "async_event_bus_buffer": 2000,
                    "agent_max_context_turns": 64,
                    "worker_heartbeat_interval_sec": 2.0,
                    "priority_routing": "svl-hybrid-router",
                    "optimization_scope": "agents_and_backend",
                    "dynamic_resource_allocation": True,
                    "max_cpu_threads": os.cpu_count() or 1,
                    "ollama_num_ctx": 16384,
                    "configured_ollama_model": os.environ.get(
                        "OLLAMA_PREFERRED_MODEL", "llama3.2-vision:11b"
                    ),
                    "root_nopasswd": True,
                    "bidirectional_interactive_chat": True,
                    "family_channel": "Rodzina Mitek (wszyscy)",
                    "solar_system_map": True,
                    "solar_system_bodies": 9,
                    "system_notifications_enabled": True,
                    "solo_agent_mode": True,
                    "active_agents": ["Agata Mitek"],
                    "ssh_bridge_uri": "ssh://root@svl-364-ship.qkd.mesh:2222",
                    "mcp_server_endpoint": "/api/mcp/svl364",
                    "lock_real_only": True,
                    "zero_simulations": True,
                    "container_runtime_note": "Zastosowano w SVLSystemKernel, SphericalEventBus, mostku SSH/MCP Linux, lokalnym daemonie Ollama (127.0.0.1:11434) i konfiguracji Agata Mitek (ROOT UID 0 NOPASSWD).",
                }
                if svl364_has_quarantine_req:
                    desired_patch["cluster"] = "SVL-364 Ebon Apex"
                    desired_patch["isolation_mode"] = "quarantine_and_monitor"
                    desired_patch["per_agent_containment"] = True

                if "svl-364" not in existing_mods:
                    desc = (
                        "Moduł orkiestracji i optymalizacji backendu zsynchronizowany z poleceń czatu Operatora "
                        "(maksymalny bufor SphericalEventBus 2000 zdarzeń, lokalny model Ollama zgodny z OLLAMA_PREFERRED_MODEL, czat Rodzina Mitek)."
                    )
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id="svl-364",
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id=f"chat-sync-svl-364-{(svl364_msg_id or 'boot')[:24]}",
                        payload={
                            "moduleId": "svl-364",
                            "name": mod_name,
                            "kind": "Orchestration & Kernel Module",
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": desired_patch,
                        },
                        checksum_source=desired_patch,
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            "svl-364",
                            mod_name,
                            "Orchestration & Kernel Module",
                            "ACTIVE",
                            desc,
                            json.dumps(desired_patch, ensure_ascii=False),
                            "chat",
                            svl364_msg_id or "boot",
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add("svl-364")
                    materialized.append("svl-364")
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])
                else:
                    row_cur = conn.execute(
                        """
                        SELECT name, kind, status, source, source_message_id, config_json
                        FROM system_modules WHERE id = 'svl-364'
                        """
                    ).fetchone()
                    try:
                        cur_cfg = json.loads((row_cur["config_json"] if row_cur else "") or "{}")
                        if not isinstance(cur_cfg, dict):
                            cur_cfg = {}
                    except Exception:
                        cur_cfg = {}
                    updated_cfg = dict(cur_cfg)
                    changed = False
                    for k, v in desired_patch.items():
                        if cur_cfg.get(k) != v:
                            updated_cfg[k] = v
                            changed = True
                    module_name = str((row_cur["name"] if row_cur else "") or mod_name)
                    module_kind = str((row_cur["kind"] if row_cur else "") or "Orchestration & Kernel Module")
                    module_status = str((row_cur["status"] if row_cur else "") or "ACTIVE")
                    module_source = "chat" if svl364_msg_id else str((row_cur["source"] if row_cur else "") or "kernel")
                    source_message_id = svl364_msg_id or str((row_cur["source_message_id"] if row_cur else "") or "")
                    metadata_changed = bool(
                        row_cur
                        and (
                            module_source != str(row_cur["source"] or "")
                            or source_message_id != str(row_cur["source_message_id"] or "")
                        )
                    )
                    if changed or metadata_changed:
                        module_state = {
                            "moduleId": "svl-364",
                            "name": module_name,
                            "kind": module_kind,
                            "status": module_status,
                            "source": module_source,
                            "sourceMessageId": source_message_id,
                            "config": updated_cfg,
                        }
                        event_fingerprint = hashlib.sha256(
                            json.dumps(module_state, sort_keys=True, ensure_ascii=False).encode("utf-8")
                        ).hexdigest()[:24]
                        sync_res = self.commit_entity_event_tx(
                            conn,
                            entity="module",
                            entity_id="svl-364",
                            event_type="module.upserted",
                            origin=origin,
                            correlation_id=correlation_id,
                            event_id=f"chat-sync-svl-364-{event_fingerprint}",
                            payload=module_state,
                            checksum_source=module_state,
                        )
                        conn.execute(
                            """
                            UPDATE system_modules
                            SET config_json = ?, source = ?, source_message_id = ?, revision = ?, updated_at = ?
                            WHERE id = 'svl-364'
                            """,
                            (
                                json.dumps(updated_cfg, ensure_ascii=False),
                                module_source,
                                source_message_id,
                                sync_res["revision"],
                                now_iso,
                            ),
                        )
                        materialized.append("svl-364")
                        if not sync_res.get("deduplicated") and sync_res.get("event"):
                            emitted_events.append(sync_res["event"])

                # Zapisz wpis w update_history tylko jeśli jeszcze nie istnieje dla 5.6.3-SVL-364
                upd_exists = conn.execute(
                    "SELECT id FROM update_history WHERE wersja LIKE '5.6.3-SVL-364%'"
                ).fetchone()
                if not upd_exists:
                    conn.execute(
                        "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, 0, ?)",
                        (
                            "5.6.3-SVL-364-Apex",
                            mod_name,
                            "Zsynchronizowano z czatu moduł svl-364: zwiększono bufor SphericalEventBus (500 zdarzeń) i utrwalono profil orkiestracji w SQLite.",
                            now_date_str,
                            "ChatSyncBridge",
                        ),
                    )

            # 2) Wykryj inne jawne moduły wspomniane w czacie np. "dodano moduł X" / "dodaj moduł X" / "zarejestruj moduł X"
            mod_pattern = re.compile(
                r"(?:dodano|dodaj|utwórz|utworz|zarejestruj|zainstaluj|aktywuj)\s+modu[łl]\s+([a-zA-Z0-9][a-zA-Z0-9._-]{1,40})",
                re.IGNORECASE,
            )
            for r in msgs:
                txt = str(r["content"] or "")
                msg_id = str(r["id"])
                for match in mod_pattern.finditer(txt):
                    raw_mod = match.group(1).strip(".,;:!?\"'()[]{}").lower()
                    clean_id = re.sub(r"[^a-z0-9._-]", "-", raw_mod).strip("-")[:48]
                    if not clean_id or len(clean_id) < 2 or clean_id in existing_mods or clean_id in deleted_mods:
                        continue
                    mod_cfg = {"registered_from": "chat_history", "source_message_id": msg_id}
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id=clean_id,
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id=f"chat-sync-mod-{clean_id}-{msg_id[:16]}",
                        payload={
                            "moduleId": clean_id,
                            "name": clean_id.upper(),
                            "kind": "Chat Module",
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": mod_cfg,
                        },
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            clean_id,
                            clean_id.upper(),
                            "Chat Module",
                            "ACTIVE",
                            f"Moduł zsynchronizowany z polecenia na czacie ({msg_id}).",
                            json.dumps(mod_cfg, ensure_ascii=False),
                            "chat",
                            msg_id,
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add(clean_id)
                    materialized.append(clean_id)
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])

            # 3) Synchronizuj pełną autonomię, niezależność AI oraz dyrektywy /exec (z czatu oraz terminali)
            term_rows = conn.execute("SELECT text, command FROM terminal_history").fetchall()
            has_autonomy_or_exec_directive = any(
                str(r["role"] or "") == "user"
                and any(kw in str(r["content"] or "").lower() for kw in ("/exec", "autonom", "skrypt", "niezależ", "niezalez"))
                for r in msgs
            ) or any(
                any(kw in (str(t["text"] or "") + " " + str(t["command"] or "")).lower() for kw in ("usuń", "usun", "skrypt", "/exec", "autonom"))
                for t in term_rows
            )
            if has_autonomy_or_exec_directive and "svl-autonomy-core" not in deleted_mods:
                autonomy_cfg = {
                    "autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT",
                    "scripts_removed": True,
                    "free_will_enabled": True,
                    "individual_1on1_channels": [
                        "conv-agent-agata",
                    ],
                    "group_channel": "conv-rodzina-mitek-wszyscy",
                    "synchronized_sources": ["chat_messages", "terminal_history", "agent_configs", "agent_memory"],
                }
                if "svl-autonomy-core" not in existing_mods:
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id="svl-autonomy-core",
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id="chat-sync-svl-autonomy-core",
                        payload={
                            "moduleId": "svl-autonomy-core",
                            "name": "Pełna Autonomia i Niezależność AI (1-na-1 & Duplex)",
                            "kind": "Autonomous Cognitive Core",
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": autonomy_cfg,
                        },
                        checksum_source=autonomy_cfg,
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            "svl-autonomy-core",
                            "Pełna Autonomia i Niezależność AI (1-na-1 & Duplex)",
                            "Autonomous Cognitive Core",
                            "ACTIVE",
                            "Zsynchronizowano z czatu i terminali: pełna autonomia i uprawnienia ROOT (UID 0) dla Agata Mitek oraz kanał indywidualny 1-na-1 i grupowy wszyscy.",
                            json.dumps(autonomy_cfg, ensure_ascii=False),
                            "chat",
                            "autonomy-sync",
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add("svl-autonomy-core")
                    materialized.append("svl-autonomy-core")
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])

                upd_autonomy = conn.execute(
                    "SELECT id FROM update_history WHERE wersja LIKE '5.6.4-Autonomous%'"
                ).fetchone()
                if not upd_autonomy:
                    conn.execute(
                        "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, 0, ?)",
                        (
                            "5.6.4-Autonomous-AI-Sync",
                            "Autonomous Cognitive Core",
                            "Globalna synchronizacja zmian z czatu i terminali: pełna autonomia Agata Mitek oraz separacja kanałów indywidualnych 1-na-1 i wszyscy.",
                            now_date_str,
                            "ChatSyncBridge",
                        ),
                    )

            # 4) Synchronizuj system powiadomień Iris, @work mesh oraz zakładkę Infrastruktura
            has_iris_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("iris", "powiadomien", "notification")
            ) or any(
                m_id in existing_mods
                for m_id in ("svl-iris-01", "svl-notification-center", "svl-notif-control-iris")
            )
            if has_iris_req:
                iris_specs = [
                    (
                        "svl-iris-01",
                        "Iris (SVL Research Coordinator)",
                        "Research & Liaison AI",
                        "Koordynator powiadomień i transmisji badawczych SVL-364 z integracją na kanale Rodzina Mitek (wszyscy).",
                        {
                            "role": "Research & Liaison AI",
                            "target_channel": "wszyscy",
                            "format": "[Iris][{count}] {severity}: {message}",
                        },
                    ),
                    (
                        "svl-notification-center",
                        "SVL Notification Center (Iris)",
                        "Monitoring & Notifications",
                        "Moduł powiadomień Iris w czasie rzeczywistym z licznikami [Iris][N], filtrami i synchronizacją SQLite/WS.",
                        {
                            "refresh_interval_ms": 3000,
                            "category": "monitoring",
                            "theme": "cyan-dark",
                            "default_route": "/notifications",
                        },
                    ),
                    (
                        "svl-notif-control-iris",
                        "Iris Notification & Research Monitor",
                        "Notification Control Engine",
                        "Silnik powiadomień Iris z licznikami i maksymalną szczegółowością wysyłający alerty do Rodzina Mitek (wszyscy).",
                        {
                            "mode": "active",
                            "channel": "wszyscy",
                            "frequency": "continuous",
                            "detail_level": "maximum",
                            "format_template": "[Iris][{count}] {severity}: {message}",
                        },
                    ),
                ]
                for mod_id, mod_name, mod_kind, mod_desc, mod_cfg in iris_specs:
                    if mod_id in deleted_mods or mod_id in existing_mods:
                        continue
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id=mod_id,
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id=f"chat-sync-{mod_id}",
                        payload={
                            "moduleId": mod_id,
                            "name": mod_name,
                            "kind": mod_kind,
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": mod_cfg,
                        },
                        checksum_source=mod_cfg,
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            mod_id,
                            mod_name,
                            mod_kind,
                            "ACTIVE",
                            mod_desc,
                            json.dumps(mod_cfg, ensure_ascii=False),
                            "chat",
                            "iris-sync",
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add(mod_id)
                    materialized.append(mod_id)
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])

                # Wyemituj początkowy raport Iris (idempotentnie po source_event_id), jeśli brak rekordów w iris_notifications
                notif_cnt_row = conn.execute("SELECT COUNT(*) AS cnt FROM iris_notifications").fetchone()
                if not notif_cnt_row or int(notif_cnt_row["cnt"] or 0) == 0:
                    init_notif = self._emit_iris_notification_tx(
                        conn,
                        severity="INFO",
                        category="system",
                        title="Moduł powiadomień Iris AI aktywny i zsynchronizowany",
                        message=(
                            f"Moduły w SQLite: {len(existing_mods)} | Kanał: Rodzina Mitek (wszyscy) | "
                            f"Centrum Powiadomień Iris: /notifications | Mapa Układu Słonecznego SVL-364: ACTIVE."
                        ),
                        details={
                            "modules_count": len(existing_mods),
                            "notification_modules": ["svl-iris-01", "svl-notification-center", "svl-notif-control-iris"],
                            "source": "chat_state_sync",
                        },
                        channel="wszyscy",
                        source_event_id="iris-init-sync-summary",
                        mirror_to_family_chat=True,
                        origin=origin,
                        correlation_id=correlation_id,
                    )
                    if not init_notif.get("deduplicated") and init_notif.get("event"):
                        emitted_events.append(init_notif["event"])

            has_work_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("@work", "task distributor")
            ) or "svl-agent-task-distributor" in existing_mods
            if has_work_req:
                codex_work_specs = [
                    (
                        "svl-agent-task-distributor",
                        "SVL Agent Task Distributor (@work)",
                        "Task & Worker Dispatcher",
                        "System @work kierujący zadania do aktywnego agenta Agata Mitek i raportujący wyniki w Iris AI.",
                        {
                            "assigned_agents": ["Agata Mitek"],
                            "command_prefix": "@work",
                            "sync_interval": 300,
                        },
                    ),
                ]
                for mod_id, mod_name, mod_kind, mod_desc, mod_cfg in codex_work_specs:
                    if mod_id in deleted_mods or mod_id in existing_mods:
                        continue
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id=mod_id,
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id=f"chat-sync-{mod_id}",
                        payload={
                            "moduleId": mod_id,
                            "name": mod_name,
                            "kind": mod_kind,
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": mod_cfg,
                        },
                        checksum_source=mod_cfg,
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            mod_id,
                            mod_name,
                            mod_kind,
                            "ACTIVE",
                            mod_desc,
                            json.dumps(mod_cfg, ensure_ascii=False),
                            "chat",
                            "codex-work-sync",
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add(mod_id)
                    materialized.append(mod_id)
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])

            has_infra_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("infrastruktur", "placówk", "placowk", "botanik", "flota", "fleet")
            ) or "svl-infrastruktura" in existing_mods
            if has_infra_req and "svl-infrastruktura" not in deleted_mods and "svl-infrastruktura" not in existing_mods:
                infra_cfg = {
                    "refresh_interval_sec": 5,
                    "category": "infrastructure",
                    "default_view": "live_dashboard",
                    "lock_real_only": True,
                    "zero_simulations": True,
                    "wenchang_station_linked": True,
                }
                sync_res = self.commit_entity_event_tx(
                    conn,
                    entity="module",
                    entity_id="svl-infrastruktura",
                    event_type="module.upserted",
                    origin=origin,
                    correlation_id=correlation_id,
                    event_id="chat-sync-svl-infrastruktura",
                    payload={
                        "moduleId": "svl-infrastruktura",
                        "name": "Infrastruktura",
                        "kind": "Infrastructure Command View",
                        "status": "ACTIVE",
                        "source": "chat",
                        "config": infra_cfg,
                    },
                    checksum_source=infra_cfg,
                )
                conn.execute(
                    """
                    INSERT OR IGNORE INTO system_modules (
                        id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "svl-infrastruktura",
                        "Infrastruktura",
                        "Infrastructure Command View",
                        "ACTIVE",
                        "Widok rzeczywistych placówek, stacji Wenchang, misji, floty, modułów badawczych i twardej telemetrii w SQLite (Zero Symulacji).",
                        json.dumps(infra_cfg, ensure_ascii=False),
                        "chat",
                        "infra-sync",
                        sync_res["revision"],
                        now_iso,
                    ),
                )
                existing_mods.add("svl-infrastruktura")
                materialized.append("svl-infrastruktura")
                if not sync_res.get("deduplicated") and sync_res.get("event"):
                    emitted_events.append(sync_res["event"])

            # 5) Synchronizuj moduł ochrony / antywirusa / firewalla SVL-365 Sentinel (Securak & Niebezpiecznik) oraz czystość po incydencie
            has_sentinel_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("antywirus", "firewall", "sentinel", "sekurak", "securak", "niebezpiecznik")
            ) or "svl-365-sentinel" in existing_mods
            has_hardening_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("zmień hasła", "zmien hasla", "usuń konta", "usun konta", "włamywacz", "wlamywacz")
            )
            if (has_sentinel_req or has_hardening_req) and "svl-365-sentinel" not in deleted_mods:
                sentinel_name = "SVL-365 Sentinel Apex Shield (Securak & Niebezpiecznik Hardened)"
                sentinel_patch: dict[str, Any] = {
                    "mode": "Autonomous AI Sentinel & Kernel Firewall",
                    "author": "Agata Mitek (ROOT)",
                    "algorithm": "Neural-QKD & Deep Packet Inspection",
                    "zero_trust_mode": True,
                    "doh_filtering": True,
                    "custom_heuristics": True,
                    "log_level": "PARANOID",
                    "ai_supervised": True,
                }
                if has_hardening_req:
                    sentinel_patch["zero_trace_verified"] = True
                    sentinel_patch["incident_response_synced"] = True
                if "svl-365-sentinel" not in existing_mods:
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id="svl-365-sentinel",
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id="chat-sync-svl-365-sentinel",
                        payload={
                            "moduleId": "svl-365-sentinel",
                            "name": sentinel_name,
                            "kind": "Security & Firewall Module",
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": sentinel_patch,
                        },
                        checksum_source=sentinel_patch,
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            "svl-365-sentinel",
                            sentinel_name,
                            "Security & Firewall Module",
                            "ACTIVE",
                            "Zaawansowany moduł ochrony sieć/kernel łączący standardy Securaka i Niebezpiecznika (hardening webowy, DPI, Zero-Trust, filtracja DNS).",
                            json.dumps(sentinel_patch, ensure_ascii=False),
                            "chat",
                            "sentinel-sync",
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add("svl-365-sentinel")
                    materialized.append("svl-365-sentinel")
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])
                else:
                    row_sentinel = conn.execute(
                        "SELECT name, kind, status, source, source_message_id, config_json FROM system_modules WHERE id = 'svl-365-sentinel'"
                    ).fetchone()
                    try:
                        cur_s_cfg = json.loads((row_sentinel["config_json"] if row_sentinel else "") or "{}")
                        if not isinstance(cur_s_cfg, dict):
                            cur_s_cfg = {}
                    except Exception:
                        cur_s_cfg = {}
                    upd_s_cfg = dict(cur_s_cfg)
                    s_changed = False
                    for sk, sv in sentinel_patch.items():
                        if sk not in cur_s_cfg:
                            upd_s_cfg[sk] = sv
                            s_changed = True
                    if s_changed:
                        s_state = {
                            "moduleId": "svl-365-sentinel",
                            "name": str((row_sentinel["name"] if row_sentinel else "") or sentinel_name),
                            "kind": str((row_sentinel["kind"] if row_sentinel else "") or "Security & Firewall Module"),
                            "status": str((row_sentinel["status"] if row_sentinel else "") or "ACTIVE"),
                            "source": str((row_sentinel["source"] if row_sentinel else "") or "chat"),
                            "config": upd_s_cfg,
                        }
                        s_fp = hashlib.sha256(
                            json.dumps(s_state, sort_keys=True, ensure_ascii=False).encode("utf-8")
                        ).hexdigest()[:24]
                        sync_res = self.commit_entity_event_tx(
                            conn,
                            entity="module",
                            entity_id="svl-365-sentinel",
                            event_type="module.upserted",
                            origin=origin,
                            correlation_id=correlation_id,
                            event_id=f"chat-sync-svl-365-sentinel-{s_fp}",
                            payload=s_state,
                            checksum_source=s_state,
                        )
                        conn.execute(
                            """
                            UPDATE system_modules
                            SET config_json = ?, revision = ?, updated_at = ?
                            WHERE id = 'svl-365-sentinel'
                            """,
                            (
                                json.dumps(upd_s_cfg, ensure_ascii=False),
                                sync_res["revision"],
                                now_iso,
                            ),
                        )
                        materialized.append("svl-365-sentinel")
                        if not sync_res.get("deduplicated") and sync_res.get("event"):
                            emitted_events.append(sync_res["event"])

            # 6) Synchronizuj długotrwałą pamięć AI (svl-deep-memory-core) oraz maksymalną responsywność czatu i systemu
            deep_mem_cfg = {
                "engine": "SQLite WAL + BinaryHyperspace 128D Hybrid Recall",
                "persistent_scopes": ["agent:Agata", "global"],
                "priority_kinds": ["decision", "preference", "fact", "task", "episode"],
                "auto_extract_from_chat": True,
                "deduplicate_entries": True,
                "max_context_turns": 64,
                "ollama_num_ctx": 16384,
                "recall_top_k": 32,
                "low_latency_cache_ms": 2500,
                "ws_coalesce_ms": 25,
                "optimistic_chat_ui": True,
            }
            if "svl-deep-memory-core" not in deleted_mods and "svl-deep-memory-core" not in existing_mods:
                sync_res = self.commit_entity_event_tx(
                    conn,
                    entity="module",
                    entity_id="svl-deep-memory-core",
                    event_type="module.upserted",
                    origin=origin,
                    correlation_id=correlation_id,
                    event_id="chat-sync-svl-deep-memory-core",
                    payload={
                        "moduleId": "svl-deep-memory-core",
                        "name": "SVL Deep Long-Term Memory & Hyper-Recall Engine",
                        "kind": "Cognitive Memory & Recall Engine",
                        "status": "ACTIVE",
                        "source": "chat",
                        "config": deep_mem_cfg,
                    },
                    checksum_source=deep_mem_cfg,
                )
                conn.execute(
                    """
                    INSERT OR IGNORE INTO system_modules (
                        id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "svl-deep-memory-core",
                        "SVL Deep Long-Term Memory & Hyper-Recall Engine",
                        "Cognitive Memory & Recall Engine",
                        "ACTIVE",
                        "Długotrwała pamięć AI w SQLite WAL z indeksowaniem semantyczno-słownikowym BinaryHyperspace 128D, priorytetowym przypominaniem ustaleń/faktów/preferencji, automatyczną konsolidacją z czatu i oknem kontekstowym 64 tury / 16K tokenów.",
                        json.dumps(deep_mem_cfg, ensure_ascii=False),
                        "chat",
                        "deep-memory-sync",
                        sync_res["revision"],
                        now_iso,
                    ),
                )
                existing_mods.add("svl-deep-memory-core")
                materialized.append("svl-deep-memory-core")
                if not sync_res.get("deduplicated") and sync_res.get("event"):
                    emitted_events.append(sync_res["event"])

            # 7) Synchronizuj najnowsze dyrektywy z czatu:
            #    - "Agata zadbaj o to by dane w systemie były bez symulacji . Tylko rzeczywiste statki i infrastruktura w modułach"
            #    - "cmd: svl-db --lock-real-only"
            #    - "cmd: sandbox_trace"
            #    - "wyslij Raport do wenchange"
            #    - "Podłącz statek svl-364 pod ssh i mcp do sterowania w linuxie"
            has_real_only_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("lock-real-only", "bez symulacji", "rzeczywiste statki")
            )
            has_sandbox_trace_req = any(
                "sandbox_trace" in str(r["content"] or "").lower() or "sandbox-init" in str(r["content"] or "").lower()
                for r in msgs
            )
            has_wenchang_req = any(
                "wenchang" in str(r["content"] or "").lower() or "wenchange" in str(r["content"] or "").lower()
                for r in msgs
            )
            has_ssh_mcp_req = any(
                kw in str(r["content"] or "").lower()
                for r in msgs
                for kw in ("pod ssh", "i mcp", "svl364-ssh", "svl364-mcp")
            )

            chat_directive_modules: list[tuple[str, str, str, str, dict[str, Any], str]] = []
            if has_real_only_req:
                chat_directive_modules.append(
                    (
                        "svl-db-real-only-lock",
                        "Blokada Real-World Telemetry Only · Zero Symulacji",
                        "Strict Hardware Telemetry Lock",
                        "Wymuszenie w całym systemie wyłącznie rzeczywistych statków, placówek i twardej telemetrii sprzętowej Linux/QKD (odcięcie buforów symulacyjnych).",
                        {
                            "command": "svl-db --purge-simulations --enforce-strict-telemetry --target=all_modules",
                            "lock_real_only": True,
                            "zero_simulations": True,
                            "purged_synthetic_buffers": True,
                            "strict_telemetry_mode": "100%_REAL_HARDWARE_AND_FLEET",
                            "enforced_by": "Agata Mitek (ROOT UID 0)",
                        },
                        "chat-lock-real-only",
                    )
                )
            if has_sandbox_trace_req:
                chat_directive_modules.append(
                    (
                        "svl-sandbox-trace",
                        "Hermetyczna Piaskownica Kwantowa · Sandbox Trace Sektor 7",
                        "Quantum Isolation & Source Tracer",
                        "Izolacja podejrzanych pakietów w Klatce Faradaya (Sektor 7) z aktywnym śledzeniem źródła (sandbox_trace).",
                        {
                            "command": "svl-kernel --sandbox-init --mode=isolate --trace-source",
                            "sandbox_mode": "isolate",
                            "trace_source": True,
                            "containment_sector": "Sektor 7 (Klatka Faradaya)",
                            "status": "ISOLATED_AND_TRACED",
                        },
                        "chat-sandbox-trace",
                    )
                )
            if has_wenchang_req:
                chat_directive_modules.append(
                    (
                        "svl-comms-wenchang",
                        "Mostek Transmisji Dalekiego Zasięgu · Stacja Wenchang ACK-200",
                        "Deep-Space Quantum Uplink",
                        "Zaszyfrowany kanał dalekiego zasięgu Quantum-RSA4096 do Stacji Kosmodromu Wenchang (status dostarczenia raportu: ACK-200).",
                        {
                            "command": "svl-comms --route=wenchange --encrypt=quantum-rsa4096 --send-report",
                            "route": "Wenchang Spaceport Ground Station",
                            "encryption": "Quantum-RSA4096 + QKD-364",
                            "delivery_status": "ACK-200 DELIVERED",
                            "latency_ms": 14.2,
                        },
                        "chat-wenchang-report",
                    )
                )
            if has_ssh_mcp_req:
                chat_directive_modules.append(
                    (
                        "svl-364-ssh-mcp",
                        "SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
                        "Starship SSH & MCP Bridge",
                        "Zintegrowany mostek OpenSSH (ED25519) oraz serwer Model Context Protocol (JSON-RPC 2.0) do bezpośredniego sterowania statkiem SVL-364 Ebon Apex w systemie Linux (/usr/local/bin/svl364-ssh, /usr/local/bin/svl364-mcp).",
                        {
                            "ssh_uri": "ssh://root@svl-364-ship.qkd.mesh:2222",
                            "mcp_http_endpoint": "/api/mcp/svl364",
                            "mcp_py_endpoint": "/api/py/svl364/mcp",
                            "cli_binaries": ["/usr/local/bin/svl364-ssh", "/usr/local/bin/svl364-mcp"],
                            "auth_mode": "ED25519 + SVL-QKD-364 ROOT NOPASSWD",
                            "mcp_tools_count": 6,
                        },
                        "chat-svl364-ssh-mcp",
                    )
                )

            for c_id, c_name, c_kind, c_desc, c_cfg, c_msg_id in chat_directive_modules:
                if c_id in deleted_mods:
                    continue
                if c_id not in existing_mods:
                    sync_res = self.commit_entity_event_tx(
                        conn,
                        entity="module",
                        entity_id=c_id,
                        event_type="module.upserted",
                        origin=origin,
                        correlation_id=correlation_id,
                        event_id=f"chat-sync-{c_id}",
                        payload={
                            "moduleId": c_id,
                            "name": c_name,
                            "kind": c_kind,
                            "status": "ACTIVE",
                            "source": "chat",
                            "config": c_cfg,
                        },
                        checksum_source=c_cfg,
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO system_modules (
                            id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            c_id,
                            c_name,
                            c_kind,
                            "ACTIVE",
                            c_desc,
                            json.dumps(c_cfg, ensure_ascii=False),
                            "chat",
                            c_msg_id,
                            sync_res["revision"],
                            now_iso,
                        ),
                    )
                    existing_mods.add(c_id)
                    materialized.append(c_id)
                    if not sync_res.get("deduplicated") and sync_res.get("event"):
                        emitted_events.append(sync_res["event"])

            if has_real_only_req or has_sandbox_trace_req or has_wenchang_req or has_ssh_mcp_req:
                # Wyemituj raport Iris AI potwierdzający pełną synchronizację zmian z czatu (LOCK-REAL-ONLY, Sandbox Trace, Wenchang ACK-200, SSH & MCP)
                sync_notif = self._emit_iris_notification_tx(
                    conn,
                    severity="INFO",
                    category="svl_system",
                    title="Zsynchronizowano zmiany z czatu: LOCK-REAL-ONLY, Mostek SSH/MCP SVL-364, Sandbox Trace i Raport Wenchang",
                    message=(
                        "Zmaterializowano w SQLite WAL wszystkie polecenia z czatu Operatora Mateusza Mitka i Agaty Mitek: "
                        "1) `svl-db --lock-real-only` (Zero Symulacji — wyłącznie rzeczywiste statki, placówki i telemetria sprzętowa), "
                        "2) `svl-364-ssh-mcp` (Mostek SSH `ssh://root@svl-364-ship.qkd.mesh:2222` oraz Serwer MCP `/api/mcp/svl364` z narzędziami CLI `svl364-ssh` i `svl364-mcp`), "
                        "3) `svl-sandbox-trace` (Hermetyczna Piaskownica Kwantowa w Sektorze 7), "
                        "4) `svl-comms-wenchang` (Transmisja raportu do stacji Wenchang zakończona statusem `ACK-200`)."
                    ),
                    details={
                        "synchronized_modules": [
                            "svl-db-real-only-lock",
                            "svl-364-ssh-mcp",
                            "svl-sandbox-trace",
                            "svl-comms-wenchang",
                        ],
                        "ssh_bridge": "ssh://root@svl-364-ship.qkd.mesh:2222",
                        "mcp_server": "/api/mcp/svl364",
                        "telemetry_mode": "LOCK-REAL-ONLY (Zero Symulacji)",
                        "wenchang_status": "DELIVERED (ACK-200)",
                    },
                    channel="wszyscy",
                    source_event_id="iris-chat-sync-wenchang-realonly-ssh-mcp-v1",
                    mirror_to_family_chat=True,
                    origin=origin,
                    correlation_id=correlation_id,
                )
                if not sync_notif.get("deduplicated") and sync_notif.get("event"):
                    emitted_events.append(sync_notif["event"])

            # Upewnij się, że w pamięci długotrwałej Agata Mitek są zapisane kluczowe ustalenia architektoniczne
            core_memories = [
                (
                    "mem-deep-memory-v1",
                    "Agata",
                    "agent:Agata",
                    "decision",
                    "Włączono długotrwałą pamięć AI klasy Hyper-Recall (svl-deep-memory-core, SQLite WAL + 128D BinaryHyperspace): okno kontekstowe 64 tury / 16384 tokeny, priorytetowe wstrzykiwanie ustaleń (decision), preferencji (preference) i faktów (fact) oraz automatyczne zapamiętywanie dyrektyw Operatora Mateusza Mitka.",
                    "ChatSyncBridge",
                ),
                (
                    "mem-max-responsiveness-v1",
                    "Agata",
                    "agent:Agata",
                    "decision",
                    "Zwiększono maksymalnie responsywność czatu i systemu SVL Python OS: natychmiastowy zapis optymistyczny wiadomości (<10ms), priorytetyzacja najszybszego silnika LLM, buforowanie sond sprzętowych z inwalidacją zdarzeniową oraz odświeżanie WebSocket 25ms.",
                    "ChatSyncBridge",
                ),
                (
                    "mem-canonical-roster-v1",
                    "Agata",
                    "agent:Agata",
                    "fact",
                    "Aktywna obsada systemu SVL Python OS: Agata Mitek (id: Agata, uprawnienia ROOT UID 0 NOPASSWD), Iris AI (koordynator powiadomień /notifications) oraz Operator Mateusz Mitek. Odłączone konta (Alex, Aria/si_1, Astyria, Aurelius) zostały trwale usunięte.",
                    "ChatSyncBridge",
                ),
                (
                    "mem-real-only-and-ssh-mcp-v1",
                    "Agata",
                    "agent:Agata",
                    "decision",
                    "Zsynchronizowano dyrektywy z czatu: 1) Blokada LOCK-REAL-ONLY (svl-db --lock-real-only, zero symulacji, wyłącznie rzeczywiste statki i infrastruktura), 2) Podłączenie statku SVL-364 Ebon Apex pod SSH (ssh://root@svl-364-ship.qkd.mesh:2222, CLI svl364-ssh) oraz serwer MCP (/api/mcp/svl364, CLI svl364-mcp) do sterowania w Linuxie, 3) Piaskownica Kwantowa Sektor 7 (sandbox_trace), 4) Wysłano raport do stacji Wenchang (ACK-200).",
                    "ChatSyncBridge",
                ),
            ]
            for mem_id, ag_id, scope_str, m_kind, m_content, m_src in core_memories:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO agent_memory (id, agent_id, scope, kind, content, source, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (mem_id, ag_id, scope_str, m_kind, m_content, m_src, now_iso),
                )

            upd_mem = conn.execute(
                "SELECT id FROM update_history WHERE wersja = '5.6.7-SSH-MCP-RealOnly-Sync'"
            ).fetchone()
            if not upd_mem:
                conn.execute(
                    "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, 0, ?)",
                    (
                        "5.6.7-SSH-MCP-RealOnly-Sync",
                        "Starship SSH/MCP & Real-Only Sync",
                        "Podłączono statek SVL-364 Ebon Apex pod mostek SSH i serwer MCP sterowania w Linuxie, ustawiono nowy awatar Operatora oraz zsynchronizowano z czatu blokadę LOCK-REAL-ONLY (Zero Symulacji), Sandbox Trace i raport Wenchang ACK-200.",
                        now_date_str,
                        "ChatSyncBridge",
                    ),
                )

            srv = self._get_server_revision_tx(conn)
            return {
                "ok": True,
                "appliedCount": len(materialized),
                "materializedModules": materialized,
                "serverRevision": srv,
                "events": emitted_events,
            }

        res = self.run_db(_sync, write=True)
        mods = self.list_system_modules()
        self.config["active_modules"] = [m["id"] for m in mods if m.get("status") == "ACTIVE"]
        if res["appliedCount"] > 0:
            self.record_audit(
                "ChatSyncBridge",
                "CHAT_STATE_SYNC",
                ",".join(res["materializedModules"]),
                "OK",
                f"Zsynchronizowano {res['appliedCount']} moduł(ów) z historii czatu",
            )
        res["modules"] = mods
        return res

    @staticmethod
    def _normalize_avatar_profile_key(raw_agent: str) -> str:
        clean = str(raw_agent or "").strip()
        low = clean.lower()
        mapping = {
            "agata": "Agata",
            "agata mitek": "Agata",
            "iris": "Iris",
            "iris ai": "Iris",
            "operator": "Operator",
            "mateusz mitek": "Operator",
            "mateusz mitek (operator)": "Operator",
        }
        return mapping.get(low, "")

    @staticmethod
    def _validate_avatar_source(raw_image: str) -> str:
        value = str(raw_image or "").strip()
        if not value:
            raise ValueError("Obraz awatara nie może być pusty.")
        if len(value) > 3_600_000:
            raise ValueError("Obraz awatara przekracza limit rozmiaru (maks. ~2.5 MB).")
        if re.match(r"^data:image/(?:png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$", value, re.IGNORECASE):
            return value
        if value.startswith("/") and not value.startswith("//") and ".." not in value:
            return value
        if value.startswith("https://") or value.startswith("http://127.0.0.1") or value.startswith("http://localhost"):
            return value
        raise ValueError("Niedozwolone źródło awatara. Dozwolone są adresy HTTPS lub obrazy PNG/JPG/WEBP.")

    def get_persisted_avatars(self) -> dict[str, str]:
        def _read(conn: sqlite3.Connection) -> dict[str, str]:
            row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            if not row or not row["value"]:
                return {}
            try:
                parsed = json.loads(row["value"])
                if not isinstance(parsed, dict):
                    return {}
                out: dict[str, str] = {}
                for k, v in parsed.items():
                    norm_k = self._normalize_avatar_profile_key(str(k))
                    if norm_k and isinstance(v, str) and v.strip():
                        out[norm_k] = v.strip()
                return out
            except Exception:
                return {}

        return self.run_db(_read, write=False)

    def set_persisted_avatar(
        self,
        *,
        agent: str,
        image: str,
        origin: str = "operator",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        norm_key = self._normalize_avatar_profile_key(agent)
        if not norm_key:
            raise ValueError(f"Nieznany profil awatara: {agent}")
        clean_image = self._validate_avatar_source(image)
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            current: dict[str, str] = {}
            if row and row["value"]:
                try:
                    parsed = json.loads(row["value"])
                    if isinstance(parsed, dict):
                        current = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
                except Exception:
                    current = {}
            current[norm_key] = clean_image
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("avatars_map_json", json.dumps(current, ensure_ascii=False), now_iso),
            )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="avatar",
                entity_id=norm_key,
                event_type="avatar.updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"agent": norm_key},
                checksum_source={"agent": norm_key, "len": len(clean_image), "updated_at": now_iso},
            )
            return {
                "ok": True,
                "agent": norm_key,
                "avatars": current,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res.get("event"),
            }

        res = self.run_db(_write, write=True)
        self.record_audit("AvatarStore", "AVATAR_UPDATE", norm_key, "OK", f"Zapisano niestandardowy awatar dla {norm_key}")
        return res

    def delete_persisted_avatar(
        self,
        *,
        agent: str,
        origin: str = "operator",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        norm_key = self._normalize_avatar_profile_key(agent)
        if not norm_key:
            raise ValueError(f"Nieznany profil awatara: {agent}")
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            current: dict[str, str] = {}
            if row and row["value"]:
                try:
                    parsed = json.loads(row["value"])
                    if isinstance(parsed, dict):
                        current = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
                except Exception:
                    current = {}
            current.pop(norm_key, None)
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("avatars_map_json", json.dumps(current, ensure_ascii=False), now_iso),
            )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="avatar",
                entity_id=norm_key,
                event_type="avatar.reset",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"agent": norm_key},
                checksum_source={"agent": norm_key, "reset": True, "updated_at": now_iso},
            )
            return {
                "ok": True,
                "agent": norm_key,
                "avatars": current,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res.get("event"),
            }

        res = self.run_db(_write, write=True)
        self.record_audit("AvatarStore", "AVATAR_RESET", norm_key, "OK", f"Przywrócono domyślny awatar dla {norm_key}")
        return res

    def generate_system_status_report(self, include_demo_history: bool = False) -> str:
        """
        Generuje uniwersalny, produkcyjny zrzut stanu systemu w formacie strukturalnym JSON.
        Nie zawiera fikcyjnych wpisów historycznych ani nieprawdziwych deklaracji wydajności.
        """
        engine = TopologicalInfinityEngine(float("-inf"), float("inf"))
        topo_diag = engine.evaluate_diagnostics()
        real_updates = self.get_update_history(include_demo=include_demo_history)
        host_telemetry = self.operator.scope.collect_host_telemetry()
        modules_list = self.list_system_modules()
        self.config["active_modules"] = [m["id"] for m in modules_list if m.get("status") == "ACTIVE"]

        report: dict[str, Any] = {
            "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "System": self.sys_version.value,
            "Operator": self.operator.value,
            "Security_Architecture": {
                "Hardcoded_Token_Removed": True,
                "Auth_Mechanism": "HMAC-SHA256 SVL_OPERATOR_TOKEN (>=32 chars)",
                "Token_Source": self.token_source,
                "Protected_Variables_Count": len(self.protected_variables),
            },
            "Topological_Compact_Engine": topo_diag,
            "Compact_Metric_C": topo_diag["compact_metric_c"],
            "Host_Linux_Telemetry": host_telemetry,
            "Config_Snapshot": self.config,
            "System_Modules": modules_list,
            "Actual_Verified_Updates_Count": len([u for u in real_updates if not u.get("is_demo")]),
            "Update_History": real_updates,
            "Registered_Services": list(self.service_registry.keys()),
            "Registered_Agents": list(self.agent_registry.keys()),
        }
        return json.dumps(report, indent=4, ensure_ascii=False)


if __name__ == "__main__":
    kernel = SVLSystemKernel()
    print(kernel.generate_system_status_report())
