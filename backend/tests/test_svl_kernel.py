#!/usr/bin/env python3
"""
Unit & Integration Tests for SVL Python OS Kernel:
- VisualScope permissions and host telemetry
- SVLProtectedVariable security (rejection of hardcoded '364_OMNIKLUCZ_ROOT' token, HMAC verification)
- TopologicalInfinityEngine mathematical compactification x / (1 + |x|) and Pythagorean metric c
- SVLSystemKernel SQLite persistence and separation of real update history from demo fixtures
- BinaryHyperspaceKernel (128-bit Hamming similarity) and WithoutNlpHarmonicEngine (Euler/Fourier)
- SphericalEventBus pub/sub and Circuit Breaker resilience
"""

from __future__ import annotations

import asyncio
import json
import math
import multiprocessing
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from hyperspace_engine import BinaryHyperspaceKernel, WithoutNlpHarmonicEngine
from spherical_bus import SphericalEventBus
from svl_core import (
    SVLProtectedVariable,
    SVLSystemKernel,
    TopologicalInfinityEngine,
    VisualScope,
    resolve_sqlite_path,
)


from agents_runtime import (
    CANONICAL_SVL_AGENTS,
    SVLAgentOrchestrator,
    _agent_worker_process_loop,
    execute_agent_task,
)


class TestSVLKernelSuite(unittest.TestCase):
    def test_relative_sqlite_paths_are_anchored_to_the_project(self) -> None:
        expected = BACKEND_DIR.parent / "data" / "svl_os.sqlite3"
        self.assertEqual(resolve_sqlite_path(), expected)
        self.assertEqual(resolve_sqlite_path("./data/svl_os.sqlite3"), expected)
        with patch.dict("os.environ", {"SVL_SQLITE_PATH": "./state/custom.sqlite3"}):
            self.assertEqual(
                resolve_sqlite_path(),
                BACKEND_DIR.parent / "state" / "custom.sqlite3",
            )

    def test_topological_infinity_engine_math(self) -> None:
        engine = TopologicalInfinityEngine(float("-inf"), float("inf"))
        self.assertAlmostEqual(engine.compact_start, -1.0)
        self.assertAlmostEqual(engine.compact_end, 1.0)
        self.assertAlmostEqual(engine.domain_length, 2.0)
        # a = 2.0, b = |-1 * 1| + 0.5 = 1.5 -> c = sqrt(4 + 2.25) = 2.5
        self.assertAlmostEqual(engine.calculate_metric_c(), 2.5, places=6)

        finite_engine = TopologicalInfinityEngine(-3.0, 3.0)
        self.assertAlmostEqual(finite_engine.compact_start, -0.75)
        self.assertAlmostEqual(finite_engine.compact_end, 0.75)
        self.assertAlmostEqual(finite_engine.domain_length, 1.5)

    def test_protected_variable_rejects_hardcoded_token_and_verifies_hmac(self) -> None:
        valid_secret = "svl_operator_secret_token_minimum_32_characters_long_99"
        var = SVLProtectedVariable("TEST_CONFIG", "initial_state")

        # Hardcoded legacy token MUST be rejected
        self.assertFalse(
            var.update_protected_value("364_OMNIKLUCZ_ROOT", "hacked", valid_secret)
        )
        self.assertEqual(var.value, "initial_state")

        # Wrong token MUST be rejected
        self.assertFalse(
            var.update_protected_value("wrong_token_of_32_chars_000000000000", "hacked", valid_secret)
        )
        self.assertEqual(var.value, "initial_state")

        # Valid HMAC token >= 32 chars MUST succeed
        self.assertTrue(
            var.update_protected_value(valid_secret, "verified_new_state", valid_secret)
        )
        self.assertEqual(var.value, "verified_new_state")

    def test_svl_system_kernel_sqlite_and_clean_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_svl.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)

            real_history = kernel.get_update_history(include_demo=False)
            self.assertGreaterEqual(len(real_history), 3)
            # Ensure no fictional '700tys_lat_wstecz' in real history
            for item in real_history:
                self.assertNotEqual(item["data"], "700tys_lat_wstecz")
                self.assertFalse(item["is_demo"])

            demo_history = kernel.get_update_history(include_demo=True)
            self.assertGreater(len(demo_history), len(real_history))

    def test_binary_hyperspace_and_without_nlp_lossless_codec(self) -> None:
        hs = BinaryHyperspaceKernel(dimensions=128)
        res = hs.resolve_intent("status systemu i diagnostyka")
        self.assertIn(res["resolved_intent"], ("SYSTEM", "CHAT", "COMPUTE", "DIAGNOSTIC"))
        self.assertEqual(len(res["vector_bits_preview"]), 64)

        wnlp = WithoutNlpHarmonicEngine()
        analysis = wnlp.analyze_signal("Mateusz Mitek SVL OS", omega=1.5, t=1.0)
        self.assertEqual(analysis["decodedText"], "Mateusz Mitek SVL OS")
        self.assertEqual(analysis["reconstructionError"], 0.0)

    def test_spherical_event_bus_pubsub(self) -> None:
        async def _run() -> None:
            bus = SphericalEventBus()
            scope = VisualScope("agent:Alex", scope_mode="CAŁOŚĆ")
            q = bus.register_worker("Alex", scope, {"status": "READY"})
            await bus.publish("svl.test", "operator", {"msg": "ping"})
            evt = await asyncio.wait_for(q.get(), timeout=1.0)
            self.assertEqual(evt.topic, "svl.test")
            self.assertEqual(evt.payload["msg"], "ping")

        asyncio.run(_run())

    def test_agents_orchestrator_full_config_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_agents.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            bus = SphericalEventBus()
            orchestrator = SVLAgentOrchestrator(kernel, bus)

            self.assertEqual(set(CANONICAL_SVL_AGENTS.keys()), {"Aria", "Alex", "Astyria", "Aurelius", "Agata"})
            self.assertEqual(orchestrator.agent_states["Aria"]["id"], "si_1")
            self.assertEqual(orchestrator.agent_states["Aria"]["config"]["ollama_model"], "llama3.2-vision:11b")
            for name in CANONICAL_SVL_AGENTS:
                config = orchestrator.get_agent_config(name)
                self.assertTrue(config["root_nopasswd"])
                self.assertEqual(config["rbac_role"], "root")
                self.assertEqual(config["autonomy_mode"], "FULL_AUTONOMY")
                self.assertIn("root", config["allowed_scopes"])
                self.assertIn("sudo_nopasswd", config["allowed_scopes"])

            custom_prompt = "Zachowuj moje ustalenia i odpowiadaj zwięźle."
            updated = orchestrator.update_agent_config(
                "Aria",
                {
                    "temperature": 0.42,
                    "ollama_model": "llama3.2-vision:11b",
                    "system_prompt": custom_prompt,
                },
            )
            self.assertAlmostEqual(updated["temperature"], 0.42)
            reloaded = orchestrator.get_agent_config("Aria")
            self.assertAlmostEqual(reloaded["temperature"], 0.42)
            self.assertEqual(reloaded["system_prompt"], custom_prompt)
            self.assertTrue(reloaded["root_nopasswd"])
            orchestrator.add_agent_memory("Aria", "Ustalenie do zachowania po restarcie.", kind="decision")

            restarted_kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            restarted_orchestrator = SVLAgentOrchestrator(restarted_kernel, bus)
            self.assertEqual(restarted_orchestrator.get_agent_config("Aria")["system_prompt"], custom_prompt)
            self.assertEqual(
                restarted_orchestrator.get_agent_memories("Aria", limit=1)[0]["content"],
                "Ustalenie do zachowania po restarcie.",
            )

            kernel.run_db(
                lambda conn: conn.execute(
                    "UPDATE agent_configs SET config_json = ? WHERE canonical_name = ?",
                    (
                        '{"root_nopasswd": true, "rbac_role": "root", '
                        '"autonomy_mode": "FULL_AUTONOMY", '
                        '"allowed_scopes": ["chat", "root", "sudo_nopasswd"]}',
                        "Aria",
                    ),
                ),
                write=True,
            )
            migrated = SVLAgentOrchestrator(kernel, bus).get_agent_config("Aria")
            self.assertTrue(migrated["root_nopasswd"])
            self.assertEqual(migrated["rbac_role"], "root")
            self.assertEqual(migrated["autonomy_mode"], "FULL_AUTONOMY")
            self.assertIn("root", migrated["allowed_scopes"])

    def test_agent_dispatch_is_persisted_until_a_worker_is_connected(self) -> None:
        async def _run() -> None:
            with tempfile.TemporaryDirectory() as tmpdir:
                kernel = SVLSystemKernel(
                    db_path=str(Path(tmpdir) / "test_agent_queue.sqlite3"),
                    operator_token="test_operator_token_with_more_than_32_chars_abcdef",
                )
                orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
                dispatched = await orchestrator.dispatch_agent_task(
                    "test-suite", "Aria", "Inspect sync", "Check event delivery."
                )

                self.assertEqual(dispatched["task"]["status"], "QUEUED")
                self.assertIsNone(dispatched["task"]["completed_at"])
                self.assertIsNone(dispatched["task"]["result"])
                self.assertEqual(dispatched["resilience"]["status"], "WAITING_FOR_WORKER")
                self.assertEqual(dispatched["event"]["type"], "agents.task_queued")

                restored = SVLAgentOrchestrator(kernel, SphericalEventBus())
                persisted = next(
                    task
                    for task in restored.agent_queues["Aria"]
                    if task["id"] == dispatched["task"]["id"]
                )
                self.assertEqual(persisted["status"], "QUEUED")
                self.assertEqual(persisted["payload"], "Check event delivery.")

        asyncio.run(_run())

    def test_agent_worker_result_updates_persistent_task(self) -> None:
        async def _run() -> None:
            with tempfile.TemporaryDirectory() as tmpdir:
                kernel = SVLSystemKernel(
                    db_path=str(Path(tmpdir) / "test_agent_result.sqlite3"),
                    operator_token="test_operator_token_with_more_than_32_chars_abcdef",
                )
                orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
                dispatched = await orchestrator.dispatch_agent_task(
                    "test-suite", "Aria", "Summarize", "A short task."
                )
                task_id = dispatched["task"]["id"]

                await orchestrator._handle_worker_message({
                    "type": "task_started",
                    "task_id": task_id,
                    "agent": "Aria",
                    "worker_pid": 1234,
                    "started_at": "2025-01-01T00:00:00+00:00",
                })
                await orchestrator._handle_worker_message({
                    "type": "task_completed",
                    "task_id": task_id,
                    "agent": "Aria",
                    "worker_pid": 1234,
                    "result": "Task result",
                    "completed_at": "2025-01-01T00:00:01+00:00",
                })

                restored = SVLAgentOrchestrator(kernel, SphericalEventBus())
                task = next(item for item in restored.agent_queues["Aria"] if item["id"] == task_id)
                self.assertEqual(task["status"], "ANSWER_READY")
                self.assertEqual(task["result"], "Task result")

        asyncio.run(_run())

    def test_agent_task_calls_ollama_with_text_only_chat(self) -> None:
        class FakeResponse:
            def __init__(self, content: str) -> None:
                self.content = content.encode("utf-8")

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return self.content

        with patch(
            "agents_runtime.urllib.request.urlopen",
            side_effect=[
                FakeResponse('{"models":[{"name":"test-model"}]}'),
                FakeResponse('{"message":{"content":"Generated answer"}}'),
            ],
        ) as mock_urlopen:
            answer = execute_agent_task({
                "ollama_host": "http://127.0.0.1:11434",
                "model": "test-model",
                "title": "Explain",
                "payload": "A test prompt.",
                "system_prompt": "Be concise.",
            })

        self.assertEqual(answer, "Generated answer")
        request = mock_urlopen.call_args_list[1].args[0]
        request_body = json.loads(request.data.decode("utf-8"))
        self.assertFalse(request_body["stream"])
        self.assertEqual([message["role"] for message in request_body["messages"]], ["system", "user"])
        self.assertNotIn("tools", request_body)

    def test_worker_process_consumes_tasks_and_reports_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            task_queue = multiprocessing.Queue()
            result_queue = multiprocessing.Queue()
            process = multiprocessing.Process(
                target=_agent_worker_process_loop,
                args=(
                    "Aria",
                    "si_1",
                    str(Path(tmpdir) / "heartbeat.json"),
                    str(Path(tmpdir) / "worker.log"),
                    task_queue,
                    result_queue,
                ),
            )
            process.start()
            try:
                task_queue.put({
                    "id": "test-task",
                    "title": "Invalid endpoint",
                    "payload": "This should fail explicitly.",
                    "ollama_host": "invalid-endpoint",
                    "model": "test-model",
                })
                started = result_queue.get(timeout=5)
                failed = result_queue.get(timeout=5)
                self.assertEqual(started["type"], "task_started")
                self.assertEqual(failed["type"], "task_failed")
                self.assertIn("Invalid Ollama endpoint", failed["error"])
            finally:
                if process.is_alive():
                    task_queue.put(None)
                    process.join(timeout=3)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=1)
                task_queue.close()
                result_queue.close()

    def test_sqlite_chat_sync_and_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_chat_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)

            saved = kernel.save_chat_message(
                "conv-sync-1",
                "Test Sync",
                "svl-hybrid-router",
                {
                    "id": "m-1",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Synchronizuj czat",
                    "timestamp": "10:00",
                },
            )
            self.assertTrue(saved["ok"])

            synced = kernel.sync_conversations([
                {
                    "id": "conv-sync-1",
                    "title": "Test Sync",
                    "messages": [
                        {"id": "m-1", "role": "user", "sender": "Mateusz", "content": "Synchronizuj czat", "timestamp": "10:00"},
                        {"id": "m-2", "role": "assistant", "sender": "Alex", "agentId": "Alex", "content": "Zsynchronizowano", "timestamp": "10:01"},
                    ],
                },
                {
                    "id": "conv-sync-2",
                    "title": "Druga sesja",
                    "messages": [
                        {"id": "m-3", "role": "user", "sender": "Mateusz", "content": "Hej", "timestamp": "10:02"},
                    ],
                },
            ])
            synced_ids = {c["id"] for c in synced}
            self.assertTrue({"conv-sync-1", "conv-sync-2"}.issubset(synced_ids))
            conv1 = next(c for c in synced if c["id"] == "conv-sync-1")
            self.assertEqual([m["id"] for m in conv1["messages"]], ["m-1", "m-2"])

            kernel.delete_conversation("conv-sync-2")
            remaining = kernel.list_conversations_with_messages()
            remaining_ids = {c["id"] for c in remaining}
            self.assertIn("conv-sync-1", remaining_ids)
            self.assertNotIn("conv-sync-2", remaining_ids)

    def test_canonical_agent_channels_survive_stale_deletions(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "channels.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            kernel.ensure_mitek_family_channel()
            ids = {c["id"] for c in kernel.list_conversations_with_messages()}
            self.assertIn("conv-agent-agata", ids)
            self.assertIn("conv-rodzina-mitek-wszyscy", ids)

            kernel.delete_conversation("conv-agent-agata")
            kernel.ensure_mitek_family_channel()
            ids = {c["id"] for c in kernel.list_conversations_with_messages()}
            self.assertIn("conv-agent-agata", ids)

    def test_system_modules_and_chat_state_sync_idempotency(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_modules_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)

            kernel.save_chat_message(
                "conv-mod-1",
                "Moduł SVL-364",
                "svl-hybrid-router",
                {
                    "id": "m-svl364-1",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Skonfiguruj cały system i daj polecenie statkowi svl-364 ebon apex",
                    "timestamp": "16:28",
                },
            )
            first_sync = kernel.sync_chat_state_mutations(origin="test-suite")
            self.assertEqual(first_sync["appliedCount"], 1)
            self.assertIn("svl-364", first_sync["materializedModules"])

            mods = kernel.list_system_modules()
            svl364 = next((m for m in mods if m["id"] == "svl-364"), None)
            self.assertIsNotNone(svl364)
            self.assertEqual(svl364["name"], "SVL-364 Ebon Apex — Centrum Dowodzenia")
            self.assertEqual(svl364["source"], "chat")
            self.assertEqual(svl364["sourceMessageId"], "m-svl364-1")
            self.assertEqual(svl364["config"].get("async_event_bus_buffer"), 2000)
            svl364_event = next(event for event in first_sync["events"] if event["entityId"] == "svl-364")
            self.assertEqual(svl364_event["payload"]["name"], svl364["name"])
            self.assertEqual(svl364_event["payload"]["source"], svl364["source"])
            self.assertEqual(svl364_event["payload"]["sourceMessageId"], svl364["sourceMessageId"])

            # Second sync MUST be strictly idempotent (appliedCount == 0)
            second_sync = kernel.sync_chat_state_mutations(origin="test-suite")
            self.assertEqual(second_sync["appliedCount"], 0)

            # Direct upsert + delete of custom module
            up = kernel.upsert_system_module(
                "custom-mod-99",
                name="Custom Module 99",
                kind="Plugin",
                description="Test plugin",
                config={"enabled": True},
            )
            self.assertEqual(up["module"]["id"], "custom-mod-99")
            self.assertTrue(any(m["id"] == "custom-mod-99" for m in kernel.list_system_modules()))

            kernel.delete_system_module("custom-mod-99")
            self.assertFalse(any(m["id"] == "custom-mod-99" for m in kernel.list_system_modules()))

    def test_solar_system_map_and_notifications_chat_sync(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_solar_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.ensure_mitek_family_channel()

            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "m-solar-1",
                    "role": "user",
                    "sender": "Operator",
                    "content": "Dodaj mapa układu słonecznego do svl-364 i włącz powiadomienia dla wszyscy",
                    "timestamp": "17:00",
                },
            )
            res1 = kernel.sync_chat_state_mutations(origin="test-solar")
            self.assertGreaterEqual(res1["appliedCount"], 1)

            svl364 = next(m for m in kernel.list_system_modules() if m["id"] == "svl-364")
            self.assertTrue(svl364["config"].get("solar_system_map"))
            self.assertEqual(svl364["config"].get("solar_system_bodies"), 9)
            self.assertTrue(svl364["config"].get("system_notifications_enabled"))
            self.assertTrue(svl364["config"].get("all_five_agents_reply"))

            res2 = kernel.sync_chat_state_mutations(origin="test-solar")
            self.assertEqual(res2["appliedCount"], 0)


if __name__ == "__main__":
    unittest.main()

