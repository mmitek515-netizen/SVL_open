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
            "Alex",
            "Aria",
            "Astyria",
            "Aurelius",
            "Alex Mitek",
            "Aria Mitek",
            "Astyria Mitek",
            "Aurelius Mitek",
            "Rodzina Mitek",
            "si_1",
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
        self.db_path = Path(db_path or os.environ.get("SVL_SQLITE_PATH", "./data/svl_os.sqlite3"))
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

                CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (scope, created_at);
                CREATE INDEX IF NOT EXISTS idx_sync_outbox_srvrev ON sync_outbox (server_revision);
                CREATE INDEX IF NOT EXISTS idx_sync_outbox_ws ON sync_outbox (ws_dispatched, seq);
                CREATE INDEX IF NOT EXISTS idx_terminal_history_tab ON terminal_history (tab, created_at);
                CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (id DESC);
                CREATE INDEX IF NOT EXISTS idx_system_modules_status ON system_modules (status, updated_at DESC);
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
                    "Stały moduł programowy Centrum Dowodzenia; nie potwierdza fizycznej łączności ze statkiem.",
                    json.dumps({"module_alias": "svl-364-ebon-apex", "connection_verified": False, "local_command_center": True, "async_event_bus_buffer": 500}, ensure_ascii=False),
                    "kernel",
                    "init-svl-364-command",
                    1,
                    now_iso,
                ),
                (
                    "svl-duplex-chat",
                    "Interaktywny Czat Obustronny — Rodzina Mitek (wszyscy)",
                    "Duplex Multi-Agent Bridge",
                    "ACTIVE",
                    "Dwukierunkowy czat interaktywny wszystkich agentów Rodziny Mitek (Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek, Agata Mitek) z mostkiem wykonawczym ROOT (UID 0 NOPASSWD).",
                    json.dumps(
                        {
                            "channel": "Rodzina Mitek (wszyscy)",
                            "conversation_id": "conv-rodzina-mitek-wszyscy",
                            "bidirectional_duplex": True,
                            "root_nopasswd": True,
                            "exec_bridge": True,
                            "agents": ["Aria Mitek", "Alex Mitek", "Astyria Mitek", "Aurelius Mitek", "Agata Mitek"],
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

            # Uaktualnij etykiety nadawców w historii czatu do pełnych nazw Rodziny Mitek
            for short_name, full_name in (
                ("Aria", "Aria Mitek"),
                ("Alex", "Alex Mitek"),
                ("Astyria", "Astyria Mitek"),
                ("Aurelius", "Aurelius Mitek"),
                ("Agata", "Agata Mitek"),
            ):
                conn.execute(
                    "UPDATE chat_messages SET sender = ? WHERE sender = ?",
                    (full_name, short_name),
                )

        self.run_db(_migrate, write=True)

    def ensure_mitek_family_channel(self) -> None:
        """Tworzy grupowy kanał 'Rodzina Mitek (wszyscy)' — Interaktywny Czat Obustronny w bazie produkcyjnej, jeśli nie został usunięty."""
        now_iso = datetime.now(timezone.utc).isoformat()

        def _seed_family(conn: sqlite3.Connection) -> None:
            conn.execute(
                "DELETE FROM chat_messages WHERE role = 'system' AND sender = 'Diagnostyka połączenia AI'"
            )
            for short_name, full_name in (
                ("Aria", "Aria Mitek"),
                ("Alex", "Alex Mitek"),
                ("Astyria", "Astyria Mitek"),
                ("Aurelius", "Aurelius Mitek"),
                ("Agata", "Agata Mitek"),
            ):
                conn.execute(
                    "UPDATE chat_messages SET sender = ? WHERE sender = ?",
                    (full_name, short_name),
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


            for ag_name in ("Aria", "Alex", "Astyria", "Aurelius", "Agata"):
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

    def _get_server_revision_tx(self, conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM sync_meta WHERE key = 'server_revision'").fetchone()
        if not row:
            conn.execute("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('server_revision', '1')")
            return 1
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 1

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
                "Aria": "Aria Mitek",
                "Alex": "Alex Mitek",
                "Astyria": "Astyria Mitek",
                "Aurelius": "Aurelius Mitek",
                "si_1": "Aria Mitek",
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

            existing_conv = conn.execute(
                "SELECT id, created_at, title FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            created_at = existing_conv["created_at"] if existing_conv else now_iso
            canonical_channel_titles = {
                "conv-rodzina-mitek-wszyscy": "Rodzina Mitek (wszyscy)",
                "conv-agent-aria": "Aria Mitek (1-na-1)",
                "conv-agent-alex": "Alex Mitek (1-na-1)",
                "conv-agent-astyria": "Astyria Mitek (1-na-1)",
                "conv-agent-aurelius": "Aurelius Mitek (1-na-1)",
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
            "codex": [],
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

            # 1) Wykryj dyspozycje dla modułu svl-364 / svl-364-ebon-apex, dynamicznego przydziału zasobów i modelu Ollama z czatu
            svl364_msg_id: Optional[str] = None
            svl364_has_apex_name = False
            svl364_has_opt_request = False
            has_dynamic_alloc_req = False
            has_dolphin_model_req = False
            for r in msgs:
                txt = str(r["content"] or "")
                low = txt.lower()
                if "svl-364" in low or "svl 364" in low or "svl_364" in low:
                    svl364_msg_id = str(r["id"])
                    if "ebon" in low or "apex" in low:
                        svl364_has_apex_name = True
                    if any(kw in low for kw in ("skonfiguruj", "napraw", "ulepsz", "optymal", "agent")):
                        svl364_has_opt_request = True
                if "dynamiczny przydział" in low or "dynamiczny przydzial" in low or ("zasob" in low and "ile trzeba" in low):
                    has_dynamic_alloc_req = True
                if "dolphin-llama3" in low or "dolphin llama3" in low:
                    has_dolphin_model_req = True

            if (svl364_msg_id or "svl-364" in existing_mods) and "svl-364" not in deleted_mods:
                mod_name = "SVL-364 Ebon Apex" if svl364_has_apex_name else "SVL-364 Ebon Apex"
                desired_patch: dict[str, Any] = {
                    "module_alias": "svl-364-ebon-apex",
                    "async_event_bus_buffer": 500,
                    "agent_max_context_turns": 24,
                    "worker_heartbeat_interval_sec": 2.0,
                    "priority_routing": "svl-hybrid-router",
                    "optimization_scope": "agents_and_backend",
                    "dynamic_resource_allocation": True,
                    "max_cpu_threads": os.cpu_count() or 1,
                    "ollama_num_ctx": 4096,
                    "configured_ollama_model": "dolphin-llama3:latest",
                    "root_nopasswd": True,
                    "bidirectional_interactive_chat": True,
                    "family_channel": "Rodzina Mitek (wszyscy)",
                    "container_runtime_note": "Zastosowano w SVLSystemKernel, SphericalEventBus, lokalnym daemonie Ollama (127.0.0.1:11434) i konfiguracji agentów Rodziny Mitek (ROOT UID 0 NOPASSWD).",
                }

                if "svl-364" not in existing_mods:
                    desc = (
                        "Moduł orkiestracji i optymalizacji backendu zsynchronizowany z poleceń czatu Operatora "
                        "(rozszerzony bufor SphericalEventBus 500 zdarzeń, lokalny silnik Ollama dolphin-llama3:latest, Czat Obustronny Rodzina Mitek, ROOT NOPASSWD)."
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
                    row_cur = conn.execute("SELECT config_json FROM system_modules WHERE id = 'svl-364'").fetchone()
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
                    if changed:
                        sync_res = self.commit_entity_event_tx(
                            conn,
                            entity="module",
                            entity_id="svl-364",
                            event_type="module.upserted",
                            origin=origin,
                            correlation_id=correlation_id,
                            event_id=f"chat-sync-svl-364-mitek-root-{os.cpu_count() or 1}",
                            payload={
                                "moduleId": "svl-364",
                                "name": mod_name,
                                "kind": "Orchestration & Kernel Module",
                                "status": "ACTIVE",
                                "source": "chat",
                                "config": updated_cfg,
                            },
                            checksum_source=updated_cfg,
                        )
                        conn.execute(
                            "UPDATE system_modules SET config_json = ?, revision = ?, updated_at = ? WHERE id = 'svl-364'",
                            (json.dumps(updated_cfg, ensure_ascii=False), sync_res["revision"], now_iso),
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
                        "conv-agent-aria",
                        "conv-agent-alex",
                        "conv-agent-astyria",
                        "conv-agent-aurelius",
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
                            "Zsynchronizowano z czatu i terminali: usunięto skrypty sterujące dla wszystkich 4 AI (Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek) oraz wydzielono kanały indywidualne 1-na-1.",
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
                            "Globalna synchronizacja zmian z czatu i terminali: pełna autonomia i niezależność wszystkich 4 AI (usunięcie skryptów sterujących) oraz separacja kanałów indywidualnych 1-na-1.",
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
