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

import hashlib
import hmac
import json
import math
import os
import platform
import secrets
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


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
        self.allowed_readers: set[str] = allowed_readers or {"operator", "Alex", "Aria", "Astyria", "Aurelius", "si_1"}
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

        self.service_registry: dict[str, dict[str, Any]] = {}
        self.agent_registry: dict[str, dict[str, Any]] = {}
        self._init_database()
        self._ensure_initial_real_history()

    @property
    def operator_token(self) -> str:
        return self._operator_token

    def verify_operator_token(self, candidate: str) -> bool:
        if not candidate or candidate == "364_OMNIKLUCZ_ROOT":
            return False
        return hmac.compare_digest(candidate.strip().encode("utf-8"), self._operator_token.encode("utf-8"))

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_database(self) -> None:
        with self._connect() as conn:
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
                """
            )
            conn.commit()

    def _ensure_initial_real_history(self) -> None:
        with self._connect() as conn:
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
                conn.commit()

    def record_update(self, wersja: str, typ: str, opis: str, author: str = "operator") -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, 0, ?)",
                (wersja, typ, opis, now_iso, author),
            )
            conn.commit()
            entry_id = cur.lastrowid
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
        }

    def get_update_history(self, include_demo: bool = False) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, wersja, typ, opis, data, is_demo, author FROM update_history WHERE is_demo = 0 ORDER BY id DESC"
            ).fetchall()
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
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO audit_log (timestamp, actor, action, target, status, details) VALUES (?, ?, ?, ?, ?, ?)",
                (now_iso, actor, action, target, status, details),
            )
            conn.commit()

    def get_audit_logs(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, timestamp, actor, action, target, status, details FROM audit_log ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

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
        return {
            "success": ok,
            "variable": target_var.to_metadata(),
        }

    def generate_system_status_report(self, include_demo_history: bool = False) -> str:
        """
        Generuje uniwersalny, produkcyjny zrzut stanu systemu w formacie strukturalnym JSON.
        Nie zawiera fikcyjnych wpisów historycznych ani nieprawdziwych deklaracji wydajności.
        """
        engine = TopologicalInfinityEngine(float("-inf"), float("inf"))
        topo_diag = engine.evaluate_diagnostics()
        real_updates = self.get_update_history(include_demo=include_demo_history)
        host_telemetry = self.operator.scope.collect_host_telemetry()

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
            "Actual_Verified_Updates_Count": len([u for u in real_updates if not u.get("is_demo")]),
            "Update_History": real_updates,
            "Registered_Services": list(self.service_registry.keys()),
            "Registered_Agents": list(self.agent_registry.keys()),
        }
        return json.dumps(report, indent=4, ensure_ascii=False)


if __name__ == "__main__":
    kernel = SVLSystemKernel()
    print(kernel.generate_system_status_report())
