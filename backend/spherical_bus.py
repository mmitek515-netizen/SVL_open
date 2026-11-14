#!/usr/bin/env python3
"""
SVL PYTHON OS — SPHERICAL WORKER ARCHITECTURE & EVENT BUS
Implements an asynchronous, polymorphic, asymmetric, and spherical event bus where:
- Every worker receives events from the central bus according to its VisualScope permissions without polling other workers.
- Built-in Pub/Sub, async task queues, heartbeat tracking, retry with exponential backoff, timeout, circuit breaker, and shared state registry.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Optional

from svl_core import VisualScope


@dataclass
class CircuitBreakerState:
    failure_threshold: int = 3
    recovery_timeout_sec: float = 15.0
    failure_count: int = 0
    state: str = "CLOSED"  # CLOSED | OPEN | HALF_OPEN
    last_failure_time: float = 0.0

    def record_success(self) -> None:
        self.failure_count = 0
        self.state = "CLOSED"

    def record_failure(self) -> None:
        self.failure_count += 1
        self.last_failure_time = time.time()
        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"

    def allow_execution(self) -> bool:
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            if time.time() - self.last_failure_time >= self.recovery_timeout_sec:
                self.state = "HALF_OPEN"
                return True
            return False
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "failure_count": self.failure_count,
            "failure_threshold": self.failure_threshold,
            "recovery_timeout_sec": self.recovery_timeout_sec,
            "last_failure_time": self.last_failure_time,
        }


@dataclass
class SphericalEvent:
    id: str
    topic: str
    source: str
    target: str  # "*" for spherical broadcast or specific agent_id
    scope_mode: str
    payload: dict[str, Any]
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "topic": self.topic,
            "source": self.source,
            "target": self.target,
            "scope_mode": self.scope_mode,
            "payload": self.payload,
            "timestamp": self.timestamp,
        }


class SphericalEventBus:
    """
    Centralna Sferyczna Magistrala Zdarzeń (Spherical Observability Bus):
    Każdy zarejestrowany worker widzi w czasie rzeczywistym wszystkie zdarzenia i stan zasobów,
    do których uprawnia go VisualScope, bez konieczności ręcznego odpytywania (polling) innych workerów.
    """

    def __init__(self) -> None:
        self.subscribers: dict[str, asyncio.Queue[SphericalEvent]] = {}
        self.worker_scopes: dict[str, VisualScope] = {}
        self.shared_state_registry: dict[str, dict[str, Any]] = {}
        self.circuit_breakers: dict[str, CircuitBreakerState] = {}
        self.event_history: list[dict[str, Any]] = []
        self.telemetry_counters: dict[str, int] = {
            "published_events": 0,
            "delivered_events": 0,
            "retried_tasks": 0,
            "timed_out_tasks": 0,
            "circuit_breaker_trips": 0,
        }

    def register_worker(self, worker_id: str, scope: VisualScope, initial_state: dict[str, Any]) -> asyncio.Queue[SphericalEvent]:
        queue: asyncio.Queue[SphericalEvent] = asyncio.Queue(maxsize=250)
        self.subscribers[worker_id] = queue
        self.worker_scopes[worker_id] = scope
        self.circuit_breakers.setdefault(worker_id, CircuitBreakerState())
        self.shared_state_registry[worker_id] = {
            **initial_state,
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            "circuit_breaker": self.circuit_breakers[worker_id].to_dict(),
        }
        return queue

    def record_heartbeat(self, worker_id: str, extra: Optional[dict[str, Any]] = None) -> None:
        if worker_id in self.shared_state_registry:
            self.shared_state_registry[worker_id]["heartbeat_at"] = datetime.now(timezone.utc).isoformat()
            if extra:
                self.shared_state_registry[worker_id].update(extra)
            if worker_id in self.circuit_breakers:
                self.shared_state_registry[worker_id]["circuit_breaker"] = self.circuit_breakers[worker_id].to_dict()

    async def publish(
        self,
        topic: str,
        source: str,
        payload: dict[str, Any],
        target: str = "*",
        scope_mode: str = "CAŁOŚĆ",
    ) -> SphericalEvent:
        event = SphericalEvent(
            id=str(uuid.uuid4()),
            topic=topic,
            source=source,
            target=target,
            scope_mode=scope_mode,
            payload=payload,
        )
        self.telemetry_counters["published_events"] += 1
        event_dict = event.to_dict()
        self.event_history.append(event_dict)
        if len(self.event_history) > 250:
            self.event_history = self.event_history[-250:]

        # Spherical distribution to all authorized workers without polling
        for worker_id, queue in list(self.subscribers.items()):
            scope = self.worker_scopes.get(worker_id)
            if scope and not scope.can_read(worker_id, is_operator=(worker_id == "operator")):
                continue
            if target not in ("*", worker_id) and scope_mode == "AGENT_SCOPED" and source != worker_id:
                continue
            try:
                queue.put_nowait(event)
                self.telemetry_counters["delivered_events"] += 1
            except asyncio.QueueFull:
                try:
                    _ = queue.get_nowait()
                    queue.put_nowait(event)
                except asyncio.QueueEmpty:
                    pass

        return event

    async def execute_with_resilience(
        self,
        worker_id: str,
        coro_factory: Callable[[], Coroutine[Any, Any, Any]],
        timeout_sec: float = 8.0,
        max_retries: int = 2,
    ) -> dict[str, Any]:
        """
        Uruchamia zadanie workera z obsługą Timeout, Retry oraz Circuit Breaker.
        """
        cb = self.circuit_breakers.setdefault(worker_id, CircuitBreakerState())
        if not cb.allow_execution():
            self.telemetry_counters["circuit_breaker_trips"] += 1
            return {
                "ok": False,
                "error": f"Circuit breaker for worker '{worker_id}' is OPEN",
                "circuit_breaker": cb.to_dict(),
            }

        last_err = None
        for attempt in range(1, max_retries + 2):
            try:
                result = await asyncio.wait_for(coro_factory(), timeout=timeout_sec)
                cb.record_success()
                self.record_heartbeat(worker_id, {"last_task_status": "SUCCESS"})
                return {
                    "ok": True,
                    "attempt": attempt,
                    "result": result,
                    "circuit_breaker": cb.to_dict(),
                }
            except asyncio.TimeoutError:
                self.telemetry_counters["timed_out_tasks"] += 1
                last_err = f"Timeout ({timeout_sec}s) on attempt {attempt}"
            except Exception as exc:
                last_err = str(exc)

            if attempt <= max_retries:
                self.telemetry_counters["retried_tasks"] += 1
                await asyncio.sleep(0.15 * attempt)

        cb.record_failure()
        self.record_heartbeat(worker_id, {"last_task_status": "FAILED", "last_error": last_err})
        return {
            "ok": False,
            "error": last_err or "Execution failed",
            "circuit_breaker": cb.to_dict(),
        }

    def get_spherical_observability_snapshot(self) -> dict[str, Any]:
        return {
            "architecture": "Spherical-Polymorphic-Async-Bus",
            "telemetry": self.telemetry_counters,
            "workers_state": self.shared_state_registry,
            "circuit_breakers": {k: v.to_dict() for k, v in self.circuit_breakers.items()},
            "recent_events": self.event_history[-40:],
        }
