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
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
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
    GITHUB_AGENT_SCOPES,
    SVLAgentOrchestrator,
    _agent_github_tool_names,
    _agent_worker_process_loop,
    execute_agent_task,
    normalize_agent_canonical_name,
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
            scope = VisualScope("agent:Agata", scope_mode="CAŁOŚĆ")
            q = bus.register_worker("Agata", scope, {"status": "READY"})
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

            self.assertEqual(set(CANONICAL_SVL_AGENTS.keys()), {"Agata"})
            self.assertEqual(orchestrator.agent_states["Agata"]["id"], "Agata")
            self.assertEqual(orchestrator.agent_states["Agata"]["config"]["ollama_model"], "llama3.2-vision:11b")
            for removed in ("Aria", "si_1", "Alex", "Astyria", "Aurelius"):
                self.assertEqual(normalize_agent_canonical_name(removed), "")
                with self.assertRaises(ValueError):
                    orchestrator.get_agent_config(removed)
            for name in CANONICAL_SVL_AGENTS:
                config = orchestrator.get_agent_config(name)
                self.assertTrue(config["root_nopasswd"])
                self.assertEqual(config["rbac_role"], "root")
                self.assertEqual(config["autonomy_mode"], "FULL_AUTONOMY")
                self.assertIn("root", config["allowed_scopes"])
                self.assertIn("sudo_nopasswd", config["allowed_scopes"])

            custom_prompt = "Zachowuj moje ustalenia i odpowiadaj zwięźle."
            updated = orchestrator.update_agent_config(
                "Agata",
                {
                    "temperature": 0.42,
                    "ollama_model": "llama3.2-vision:11b",
                    "system_prompt": custom_prompt,
                },
            )
            self.assertAlmostEqual(updated["temperature"], 0.42)
            reloaded = orchestrator.get_agent_config("Agata")
            self.assertAlmostEqual(reloaded["temperature"], 0.42)
            self.assertEqual(reloaded["system_prompt"], custom_prompt)
            self.assertTrue(reloaded["root_nopasswd"])
            orchestrator.add_agent_memory("Agata", "Ustalenie do zachowania po restarcie.", kind="decision")

            restarted_kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            restarted_orchestrator = SVLAgentOrchestrator(restarted_kernel, bus)
            self.assertEqual(restarted_orchestrator.get_agent_config("Agata")["system_prompt"], custom_prompt)
            self.assertEqual(
                restarted_orchestrator.get_agent_memories("Agata", limit=1)[0]["content"],
                "Ustalenie do zachowania po restarcie.",
            )

            kernel.run_db(
                lambda conn: conn.execute(
                    "UPDATE agent_configs SET config_json = ? WHERE canonical_name = ?",
                    (
                        '{"root_nopasswd": true, "rbac_role": "root", '
                        '"autonomy_mode": "FULL_AUTONOMY", '
                        '"allowed_scopes": ["chat", "root", "sudo_nopasswd"]}',
                        "Agata",
                    ),
                ),
                write=True,
            )
            migrated = SVLAgentOrchestrator(kernel, bus).get_agent_config("Agata")
            self.assertTrue(migrated["root_nopasswd"])
            self.assertEqual(migrated["rbac_role"], "root")
            self.assertEqual(migrated["autonomy_mode"], "FULL_AUTONOMY")
            self.assertIn("root", migrated["allowed_scopes"])

    def test_agent_dispatch_is_persisted_and_submitted_to_a_live_worker(self) -> None:
        async def _run() -> None:
            with tempfile.TemporaryDirectory() as tmpdir:
                kernel = SVLSystemKernel(
                    db_path=str(Path(tmpdir) / "test_agent_queue.sqlite3"),
                    operator_token="test_operator_token_with_more_than_32_chars_abcdef",
                )
                orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
                dispatched = await orchestrator.dispatch_agent_task(
                    "test-suite", "Agata", "Inspect sync", "Check event delivery."
                )

                self.assertEqual(dispatched["task"]["status"], "QUEUED")
                self.assertIsNone(dispatched["task"]["completed_at"])
                self.assertIsNone(dispatched["task"]["result"])
                self.assertEqual(dispatched["resilience"]["status"], "WAITING_FOR_WORKER")
                self.assertEqual(dispatched["event"]["type"], "agents.task_queued")

                restored = SVLAgentOrchestrator(kernel, SphericalEventBus())
                persisted = next(
                    task
                    for task in restored.agent_queues["Agata"]
                    if task["id"] == dispatched["task"]["id"]
                )
                self.assertEqual(persisted["status"], "QUEUED")
                self.assertEqual(persisted["payload"], "Check event delivery.")
                self.assertEqual(
                    restored._build_worker_payload(persisted)["ai_provider"],
                    "codex",
                )

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
                    "test-suite", "Agata", "Summarize", "A short task."
                )
                task_id = dispatched["task"]["id"]

                await orchestrator._handle_worker_message({
                    "type": "task_started",
                    "task_id": task_id,
                    "agent": "Agata",
                    "worker_pid": 1234,
                    "started_at": "2025-01-01T00:00:00+00:00",
                })
                await orchestrator._handle_worker_message({
                    "type": "task_answer_ready",
                    "task_id": task_id,
                    "agent": "Agata",
                    "worker_pid": 1234,
                    "result": "Task result",
                    "completed_at": "2025-01-01T00:00:01+00:00",
                })

                restored = SVLAgentOrchestrator(kernel, SphericalEventBus())
                task = next(item for item in restored.agent_queues["Agata"] if item["id"] == task_id)
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
        self.assertIn("no mission registry", request_body["messages"][0]["content"])
        self.assertNotIn("tools", request_body)

    def test_agent_task_uses_codex_only_when_selected_and_scopes_github_tools(self) -> None:
        codex_response = json.dumps({
            "type": "item.completed",
            "item": {"type": "agent_message", "text": "Generated by Codex"},
        })

        def fake_codex_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
            if command[1:3] == ["login", "status"]:
                return subprocess.CompletedProcess(command, 0, stdout="Logged in using ChatGPT", stderr="")
            return subprocess.CompletedProcess(command, 0, stdout=codex_response, stderr="")

        with (
            patch.dict(
                "agents_runtime.os.environ",
                {
                    "SVL_CODEX_AGENTS_ENABLED": "true",
                    "SVL_OPERATOR_TOKEN": "test_operator_token_with_more_than_32_chars_abcdef",
                },
            ),
            patch("agents_runtime.shutil.which", return_value="/usr/bin/codex"),
            patch("agents_runtime.subprocess.run", side_effect=fake_codex_run) as mock_run,
            patch("agents_runtime.urllib.request.urlopen") as mock_ollama,
        ):
            answer = execute_agent_task({
                "ai_provider": "codex",
                "title": "Review GitHub repository",
                "payload": "Read package.json.",
                "system_prompt": "Be concise.",
                "allowed_scopes": ["github.read"],
            })

        self.assertEqual(answer, "Generated by Codex")
        mock_ollama.assert_not_called()
        command = mock_run.call_args_list[1].args[0]
        self.assertIn("--sandbox", command)
        self.assertIn("read-only", command)
        self.assertIn("--ephemeral", command)
        self.assertIn("--ignore-user-config", command)
        self.assertNotIn("mcp_servers.svl-workspace-filesystem.enabled=false", command)
        self.assertIn("mcp_servers.svl-github.enabled=true", command)
        self.assertIn('mcp_servers.svl-github.enabled_tools=["github_read_file"]', command)
        self.assertIn('mcp_servers.svl-github.bearer_token_env_var="SVL_OPERATOR_TOKEN"', command)
        self.assertIn("GitHub policy", mock_run.call_args_list[1].kwargs["input"])

    def test_codex_agent_timeout_is_reported_clearly(self) -> None:
        timeout = subprocess.TimeoutExpired(["codex"], timeout=85)
        with (
            patch.dict("agents_runtime.os.environ", {"SVL_CODEX_AGENTS_ENABLED": "true"}),
            patch("agents_runtime.shutil.which", return_value="/usr/bin/codex"),
            patch(
                "agents_runtime.subprocess.run",
                side_effect=[
                    subprocess.CompletedProcess(
                        ["codex", "login", "status"],
                        0,
                        stdout="Logged in using ChatGPT",
                        stderr="",
                    ),
                    timeout,
                ],
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "Codex CLI task timed out after 85 seconds"):
                execute_agent_task({
                    "ai_provider": "codex",
                    "title": "Timed Codex task",
                    "payload": "Test timeout handling.",
                })

    def test_codex_agent_tasks_require_server_enablement(self) -> None:
        with (
            patch.dict("agents_runtime.os.environ", {"SVL_CODEX_AGENTS_ENABLED": "false"}),
            patch("agents_runtime.subprocess.run") as mock_run,
        ):
            with self.assertRaisesRegex(RuntimeError, "Codex agent tasks are disabled"):
                execute_agent_task({"ai_provider": "codex"})
        mock_run.assert_not_called()

    def test_agent_task_rejects_unknown_ai_provider(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported agent AI provider"):
            execute_agent_task({"ai_provider": "unknown"})

    def test_agent_github_mcp_tools_require_scope_and_explicit_github_intent(self) -> None:
        read_task = {
            "title": "Review GitHub repository",
            "payload": "Read the current implementation.",
            "allowed_scopes": ["github.read"],
        }
        self.assertEqual(_agent_github_tool_names(read_task), ["github_read_file"])

        write_task = {
            "title": "Update GitHub source",
            "payload": "Fix the documented bug and commit the source change.",
            "allowed_scopes": ["github.read", "github.write_sync"],
        }
        self.assertEqual(
            _agent_github_tool_names(write_task),
            ["github_read_file", "github_update_file"],
        )

        no_github_intent = {
            "title": "Explain a Python function",
            "payload": "Use the same agent scopes.",
            "allowed_scopes": ["github.read", "github.write_sync"],
        }
        self.assertEqual(_agent_github_tool_names(no_github_intent), [])

        read_only_write_request = {
            **write_task,
            "allowed_scopes": ["github.read"],
        }
        self.assertEqual(_agent_github_tool_names(read_only_write_request), ["github_read_file"])

    def test_worker_mission_completion_claim_is_blocked_without_verified_state(self) -> None:
        guarded = guard_unverified_mission_completion(
            "Prowadzę misję, sprawdź status procedury.",
            "Cała procedura misji dobiegła już końca.",
        )
        self.assertIn("Status misji: NIEZWERYFIKOWANY", guarded)
        planned = "Procedurę można uznać za zakończoną dopiero po weryfikacji każdego kroku."
        self.assertEqual(
            guard_unverified_mission_completion("Opisz procedurę misji.", planned),
            planned,
        )

    def test_worker_process_consumes_tasks_and_reports_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            task_queue = multiprocessing.Queue()
            result_queue = multiprocessing.Queue()
            process = multiprocessing.Process(
                target=_agent_worker_process_loop,
                args=(
                    "Agata",
                    "Agata",
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
                        {"id": "m-2", "role": "assistant", "sender": "Agata", "agentId": "Agata", "content": "Zsynchronizowano", "timestamp": "10:01"},
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
            self.assertTrue(svl364["config"].get("solo_agent_mode"))
            self.assertEqual(svl364["config"].get("active_agents"), ["Agata Mitek"])

            res2 = kernel.sync_chat_state_mutations(origin="test-solar")
            self.assertEqual(res2["appliedCount"], 0)

    def test_iris_notifications_and_work_chat_sync(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_iris_work.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.ensure_mitek_family_channel()

            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "m-iris-work-1",
                    "role": "user",
                    "sender": "Operator",
                    "content": "Iris włącz powiadomienia oraz @work synchronizuj infrastrukturę",
                    "timestamp": "18:00",
                },
            )
            sync1 = kernel.sync_chat_state_mutations(origin="test-iris")
            self.assertGreaterEqual(sync1["appliedCount"], 4)
            mod_ids = {m["id"] for m in kernel.list_system_modules()}
            self.assertTrue({
                "svl-iris-01",
                "svl-notification-center",
                "svl-notif-control-iris",
                "svl-agent-task-distributor",
                "svl-infrastruktura",
            }.issubset(mod_ids))
            self.assertNotIn("svl-codex-mesh", mod_ids)

            # Repeat sync must stay strictly idempotent
            sync2 = kernel.sync_chat_state_mutations(origin="test-iris")
            self.assertEqual(sync2["appliedCount"], 0)

            # Check initial Iris notification and mirroring to conv-rodzina-mitek-wszyscy
            listed = kernel.list_iris_notifications(limit=20)
            self.assertEqual(listed["totalCount"], 1)
            self.assertEqual(listed["unreadCount"], 1)
            self.assertEqual(listed["notifications"][0]["seqNum"], 1)
            self.assertIn("[Iris][1]", listed["notifications"][0]["formattedLine"])

            # Emit second notification + verify deduplication via source_event_id
            em2 = kernel.emit_iris_notification(
                severity="WARN",
                category="agents_work",
                title="Zadanie @work zakończone",
                message="Raport sieci SVL_System",
                source_event_id="evt-dedupe-1",
            )
            self.assertFalse(em2["deduplicated"])
            self.assertEqual(em2["notification"]["seqNum"], 2)

            em2_dup = kernel.emit_iris_notification(
                severity="WARN",
                category="agents_work",
                title="Zadanie @work zakończone",
                message="Raport sieci SVL_System",
                source_event_id="evt-dedupe-1",
            )
            self.assertTrue(em2_dup["deduplicated"])
            self.assertEqual(kernel.list_iris_notifications()["totalCount"], 2)

            convs = kernel.list_conversations_with_messages()
            fam = next(c for c in convs if c["id"] == "conv-rodzina-mitek-wszyscy")
            iris_msgs = [m for m in fam["messages"] if m["sender"] == "Iris AI"]
            self.assertEqual(len(iris_msgs), 2)
            self.assertIn("[Iris][2]", iris_msgs[1]["content"])
            self.assertIn("SVL-364 Ebon Apex", iris_msgs[1]["content"])

            ack = kernel.mark_iris_notifications_read()
            self.assertEqual(ack["updatedCount"], 2)
            self.assertEqual(ack["unreadCount"], 0)

    def test_persisted_avatars_crud(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(db_path=str(Path(tmpdir) / "svl_avatars_test.sqlite3"))
            self.assertEqual(kernel.get_persisted_avatars(), {})

            saved = kernel.set_persisted_avatar(
                agent="Agata",
                image="https://example.com/agata.png",
                origin="test-suite",
            )
            self.assertTrue(saved["ok"])
            self.assertEqual(saved["agent"], "Agata")
            self.assertEqual(kernel.get_persisted_avatars()["Agata"], "https://example.com/agata.png")

            for removed in ("Aria", "si_1", "Alex", "Astyria", "Aurelius"):
                with self.assertRaises(ValueError):
                    kernel.set_persisted_avatar(agent=removed, image="https://example.com/x.png")

            with self.assertRaises(ValueError):
                kernel.set_persisted_avatar(agent="Iris", image="javascript:alert(1)")

            reset = kernel.delete_persisted_avatar(agent="Agata", origin="test-suite")
            self.assertTrue(reset["ok"])
            self.assertNotIn("Agata", kernel.get_persisted_avatars())

    def test_decommissioned_agents_purged_from_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "svl_purge_test.sqlite3"
            kernel = SVLSystemKernel(db_path=str(db_path))

            def _seed_legacy(conn) -> None:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS agent_configs "
                    "(canonical_name TEXT PRIMARY KEY, agent_id TEXT, config_json TEXT, updated_at TEXT)"
                )
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS agent_tasks "
                    "(id TEXT PRIMARY KEY, target_agent TEXT, sender TEXT, title TEXT, payload TEXT, status TEXT, created_at TEXT)"
                )
                for cid, aid in (("Aria", "si_1"), ("Alex", "Alex"), ("Astyria", "Astyria"), ("Aurelius", "Aurelius"), ("Agata", "Agata")):
                    conn.execute(
                        "INSERT OR REPLACE INTO agent_configs (canonical_name, agent_id, config_json, updated_at) VALUES (?, ?, ?, ?)",
                        (cid, aid, "{}", "2026-01-01T00:00:00Z"),
                    )
                conn.execute(
                    "INSERT OR REPLACE INTO agent_tasks (id, target_agent, sender, title, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("task-alex-1", "Alex", "Alex Mitek", "Old task", "payload", "QUEUED", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO agent_tasks (id, target_agent, sender, title, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("task-agata-1", "Agata", "Agata Mitek", "Keep task", "payload", "QUEUED", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT INTO agent_memory (id, agent_id, scope, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("mem-alex-1", "Alex", "agent:Alex", "decision", "Stara pamięć Alexa", "test", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT INTO agent_memory (id, agent_id, scope, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("mem-agata-1", "Agata", "agent:Agata", "decision", "Pamięć Agaty", "test", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    ("conv-agent-alex", "Alex Mitek (1-na-1)", "svl-hybrid-router", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
                    ("msg-alex-1", "conv-agent-alex", "assistant", "Alex Mitek", "Hej", '{"agentId":"Alex"}', "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO iris_notifications (id, seq_num, severity, category, title, message, details_json, channel, is_read, created_at) VALUES (?, 99, 'INFO', 'system', 'Test 5/5', 'Workery Mitek: 5/5 aktywne — Alex', '{\"agent\":\"Alex\",\"workers_online\":5}', 'wszyscy', 0, ?)",
                    ("notif-old-1", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES ('avatars_map_json', ?, ?)",
                    ('{"Aria":"https://example.com/aria.png","Alex":"https://example.com/alex.png","Agata":"https://example.com/agata.png","Iris":"https://example.com/iris.png"}', "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO workspace_ui_state (key, value_json, revision, updated_at) VALUES ('active_conversation_id', '\"conv-agent-alex\"', 1, ?)",
                    ("2026-01-01T00:00:00Z",),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO workspace_ui_state (key, value_json, revision, updated_at) VALUES ('selected_target_agent', '\"Alex\"', 1, ?)",
                    ("2026-01-01T00:00:00Z",),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO workspace_ui_state (key, value_json, revision, updated_at) VALUES ('selected_agent_panel_id', '\"Alex\"', 1, ?)",
                    ("2026-01-01T00:00:00Z",),
                )

            kernel.run_db(_seed_legacy, write=True)

            # Re-initializing SVLSystemKernel must idempotently purge all decommissioned agents while keeping Agata & Iris
            restarted = SVLSystemKernel(db_path=str(db_path))

            def _verify(conn):
                cfg_names = {r["canonical_name"] for r in conn.execute("SELECT canonical_name FROM agent_configs").fetchall()}
                task_ids = {r["id"] for r in conn.execute("SELECT id FROM agent_tasks").fetchall()}
                mem_agents = {r["agent_id"] for r in conn.execute("SELECT agent_id FROM agent_memory").fetchall()}
                conv_ids = {r["id"] for r in conn.execute("SELECT id FROM conversations").fetchall()}
                notif_ids = {r["id"] for r in conn.execute("SELECT id FROM iris_notifications").fetchall()}
                ws = {r["key"]: json.loads(r["value_json"]) for r in conn.execute("SELECT key, value_json FROM workspace_ui_state").fetchall()}
                return cfg_names, task_ids, mem_agents, conv_ids, notif_ids, ws

            cfg_names, task_ids, mem_agents, conv_ids, notif_ids, ws = restarted.run_db(_verify, write=False)
            self.assertEqual(cfg_names, {"Agata"})
            self.assertEqual(task_ids, {"task-agata-1"})
            self.assertEqual(mem_agents, {"Agata"})
            self.assertNotIn("conv-agent-alex", conv_ids)
            self.assertIn("conv-agent-agata", conv_ids)
            self.assertNotIn("notif-old-1", notif_ids)
            self.assertEqual(ws.get("active_conversation_id"), "conv-rodzina-mitek-wszyscy")
            self.assertEqual(ws.get("selected_target_agent"), "Rodzina Mitek")
            self.assertEqual(ws.get("selected_agent_panel_id"), "Agata")
            avatars = restarted.get_persisted_avatars()
            self.assertEqual(set(avatars.keys()), {"Agata", "Iris"})

    def test_chat_quarantine_and_sentinel_sync(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "svl_sentinel_test.sqlite3"
            kernel = SVLSystemKernel(db_path=str(db_path))
            kernel.save_chat_message(
                "conv-agent-agata",
                "Agata Mitek (1-na-1)",
                "svl-hybrid-router",
                {
                    "id": "u-reloc-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Przenieś nasze na statek svl-364 każdego oddziel i kwarantanna",
                },
            )
            kernel.save_chat_message(
                "conv-agent-agata",
                "Agata Mitek (1-na-1)",
                "svl-hybrid-router",
                {
                    "id": "u-sentinel-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Zrób najlepszego antywirusa i firewalla z sekurak i niebezpiecznik, zmień hasła i usuń konta",
                },
            )
            res = kernel.sync_chat_state_mutations(origin="test-suite")
            self.assertTrue(res["ok"])
            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-364", mods)
            self.assertEqual(mods["svl-364"]["config"].get("isolation_mode"), "quarantine_and_monitor")
            self.assertTrue(mods["svl-364"]["config"].get("per_agent_containment"))
            self.assertIn("svl-365-sentinel", mods)
            self.assertEqual(mods["svl-365-sentinel"]["config"].get("log_level"), "PARANOID")
            self.assertTrue(mods["svl-365-sentinel"]["config"].get("zero_trust_mode"))
            self.assertTrue(mods["svl-365-sentinel"]["config"].get("zero_trace_verified"))


if __name__ == "__main__":
    unittest.main()
