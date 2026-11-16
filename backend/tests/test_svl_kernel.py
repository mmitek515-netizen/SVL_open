#!/usr/bin/env python3
"""
Unit & Integration Tests for SVL Python OS Kernel:
- VisualScope permissions and host telemetry
- SVLProtectedVariable security (rejection of hardcoded '364_OMNIKLUCZ_ROOT' token, HMAC verification)
- TopologicalInfinityEngine mathematical compactification x / (1 + |x|) and Pythagorean metric c
- SVLSystemKernel SQLite persistence and explicit update history
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
    guard_unverified_mission_completion,
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

            self.assertEqual(kernel.get_update_history(), [])
            recorded = kernel.record_update(
                "test-release",
                "test",
                "Explicitly recorded test update",
            )
            self.assertFalse(recorded["is_demo"])
            self.assertEqual([item["wersja"] for item in kernel.get_update_history()], ["test-release"])

    def test_startup_removes_known_nonproduction_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_cleanup.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.upsert_system_module(
                "svl-autonomy-core",
                name="Full autonomy",
                source="chat",
                config={"free_will_enabled": True},
            )
            kernel.upsert_system_module(
                "legacy-chat-placeholder",
                name="LEGACY-CHAT-PLACEHOLDER",
                kind="Chat Module",
                source="chat",
                config={"registered_from": "chat_history"},
            )
            kernel.run_db(
                lambda conn: (
                    conn.execute(
                        "UPDATE system_modules SET config_json = ? WHERE id = 'svl-364'",
                        ('{"root_nopasswd": true, "dynamic_resource_allocation": true, "async_event_bus_buffer": 2000}',),
                    ),
                    conn.execute(
                        "UPDATE system_modules SET config_json = ?, description = ? WHERE id = 'svl-duplex-chat'",
                        ('{"root_nopasswd": true, "exec_bridge": true}', "ROOT NOPASSWD bridge"),
                    ),
                    conn.execute(
                        "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, ?, ?)",
                        ("5.6.3-SVL-364-Apex", "demo", "fake", "now", 0, "test"),
                    ),
                    conn.execute(
                        "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, ?, ?)",
                        ("demo-row", "DEMO_FIXTURE", "fixture", "now", 1, "test"),
                    ),
                ),
                write=True,
            )

            cleaned = SVLSystemKernel(db_path=db_file, operator_token=token)
            self.assertEqual(cleaned.get_update_history(), [])
            modules = {module["id"]: module for module in cleaned.list_system_modules()}
            self.assertNotIn("svl-autonomy-core", modules)
            self.assertNotIn("legacy-chat-placeholder", modules)
            self.assertEqual(
                modules["svl-364"]["config"],
                {"async_event_bus_buffer": 2000},
            )
            self.assertNotIn("root_nopasswd", modules["svl-duplex-chat"]["config"])
            self.assertNotIn("exec_bridge", modules["svl-duplex-chat"]["config"])
            self.assertNotIn("ROOT", modules["svl-duplex-chat"]["description"])

    def test_chat_mention_does_not_mutate_module_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "test_chat_mention.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            original = next(
                module for module in kernel.list_system_modules() if module["id"] == "svl-364"
            )
            kernel.save_chat_message(
                "conv-test",
                "Question",
                "svl-hybrid-router",
                {
                    "id": "m-svl364-mention",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Czy moduł svl-364 jest skonfigurowany?",
                    "timestamp": "16:30",
                },
            )

            result = kernel.sync_chat_state_mutations(origin="test-suite")
            current = next(
                module for module in result["modules"] if module["id"] == "svl-364"
            )
            self.assertEqual(result["appliedCount"], 0)
            self.assertEqual(current["config"], original["config"])
            self.assertEqual(current["source"], original["source"])

    def test_binary_hyperspace_and_without_nlp_lossless_codec(self) -> None:
        hs = BinaryHyperspaceKernel(dimensions=128)
        res = hs.resolve_intent("status systemu i diagnostyka")
        self.assertIn(res["resolved_intent"], ("SYSTEM", "CHAT", "COMPUTE", "DIAGNOSTIC"))
        self.assertEqual(len(res["vector_bits_preview"]), 64)

        wnlp = WithoutNlpHarmonicEngine()
        analysis = wnlp.analyze_signal("Mateusz Mitek SVL OS", omega=1.5, t=1.0)
        self.assertEqual(analysis["decodedText"], "Mateusz Mitek SVL OS")
        self.assertEqual(analysis["reconstructionError"], 0.0)

    def test_hyperspace_endpoint_rejects_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict("os.environ", {"SVL_SQLITE_PATH": str(Path(tmpdir) / "app.sqlite3")}):
                import app as backend_app
                status, response = asyncio.run(
                    backend_app.handle_api_request(
                        "POST",
                        "/api/py/hyperspace/compute",
                        {},
                        {},
                    )
                )

        self.assertEqual(status, 400)
        self.assertFalse(response["ok"])
        self.assertIn("tekst", response["error"])

    def test_spherical_event_bus_pubsub(self) -> None:
        async def _run() -> None:
            bus = SphericalEventBus()
            scope = VisualScope("agent:Alex", scope_mode="CAŁOŚĆ", allowed_readers={"Alex"})
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
                self.assertFalse(config["root_nopasswd"])
                self.assertEqual(config["rbac_role"], "assistant")
                self.assertEqual(config["autonomy_mode"], "SUPERVISED_TOOL_USE")
                self.assertNotIn("root", config["allowed_scopes"])
                self.assertNotIn("sudo_nopasswd", config["allowed_scopes"])
                self.assertTrue(set(GITHUB_AGENT_SCOPES).issubset(config["allowed_scopes"]))

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
            self.assertFalse(reloaded["root_nopasswd"])
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
                        '{"root_nopasswd": true, "rbac_role": "autonomous_independent_ai", '
                        '"autonomy_mode": "FULL_AUTONOMOUS_INDEPENDENT", '
                        '"allowed_scopes": ["chat", "root", "sudo_nopasswd"]}',
                        "Aria",
                    ),
                ),
                write=True,
            )
            migrated = SVLAgentOrchestrator(kernel, bus).get_agent_config("Aria")
            self.assertFalse(migrated["root_nopasswd"])
            self.assertEqual(migrated["rbac_role"], "assistant")
            self.assertEqual(migrated["autonomy_mode"], "SUPERVISED_TOOL_USE")
            self.assertEqual(
                migrated["allowed_scopes"],
                ["chat", *GITHUB_AGENT_SCOPES],
            )

    def test_agent_dispatch_is_persisted_and_submitted_to_a_live_worker(self) -> None:
        async def _run() -> None:
            with tempfile.TemporaryDirectory() as tmpdir:
                kernel = SVLSystemKernel(
                    db_path=str(Path(tmpdir) / "test_agent_queue.sqlite3"),
                    operator_token="test_operator_token_with_more_than_32_chars_abcdef",
                )
                orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
                with patch.dict("agents_runtime.os.environ", {"SVL_CODEX_AGENTS_ENABLED": "true"}):
                    dispatched = await orchestrator.dispatch_agent_task(
                        "test-suite",
                        "Aria",
                        "Inspect sync",
                        "Check event delivery.",
                        ai_provider="codex",
                    )

                self.assertEqual(dispatched["task"]["status"], "QUEUED")
                self.assertIsNone(dispatched["task"]["completed_at"])
                self.assertIsNone(dispatched["task"]["result"])
                self.assertEqual(dispatched["resilience"]["status"], "SUBMITTED_TO_WORKER")
                self.assertTrue(dispatched["resilience"]["workerAccepted"])
                self.assertEqual(dispatched["event"]["type"], "agents.task_queued")

                restored = SVLAgentOrchestrator(kernel, SphericalEventBus())
                persisted = next(
                    task
                    for task in restored.agent_queues["Aria"]
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
                    "type": "task_answer_ready",
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
                    "content": "Skonfiguruj cały system dla modułu svl-364",
                    "timestamp": "16:28",
                },
            )
            first_sync = kernel.sync_chat_state_mutations(origin="test-suite")
            self.assertEqual(first_sync["appliedCount"], 1)
            self.assertIn("svl-364", first_sync["materializedModules"])

            mods = kernel.list_system_modules()
            svl364 = next((m for m in mods if m["id"] == "svl-364"), None)
            self.assertIsNotNone(svl364)
            self.assertEqual(svl364["name"], "SVL-364 — Centrum Dowodzenia")
            self.assertEqual(svl364["source"], "chat")
            self.assertEqual(svl364["sourceMessageId"], "m-svl364-1")
            self.assertEqual(svl364["config"].get("async_event_bus_buffer"), 2000)
            self.assertNotIn("root_nopasswd", svl364["config"])
            self.assertNotIn("dynamic_resource_allocation", svl364["config"])
            svl364_event = next(event for event in first_sync["events"] if event["entityId"] == "svl-364")
            self.assertEqual(svl364_event["payload"]["name"], svl364["name"])
            self.assertEqual(svl364_event["payload"]["source"], svl364["source"])
            self.assertEqual(svl364_event["payload"]["sourceMessageId"], svl364["sourceMessageId"])

            # Second sync MUST be strictly idempotent (appliedCount == 0)
            second_sync = kernel.sync_chat_state_mutations(origin="test-suite")
            self.assertEqual(second_sync["appliedCount"], 0)

            kernel.save_chat_message(
                "conv-mod-1",
                "Moduł telemetry-placeholder",
                "svl-hybrid-router",
                {
                    "id": "m-placeholder-1",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Dodaj moduł telemetry-placeholder",
                    "timestamp": "16:29",
                },
            )
            placeholder_sync = kernel.sync_chat_state_mutations(origin="test-suite")
            self.assertEqual(placeholder_sync["appliedCount"], 0)
            self.assertFalse(any(m["id"] == "telemetry-placeholder" for m in placeholder_sync["modules"]))

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

    def test_chat_command_module_changes_are_persisted_as_visible_chat_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict("os.environ", {"SVL_SQLITE_PATH": str(Path(tmpdir) / "app.sqlite3")}):
                import app as backend_app

            class FakeKernel:
                def __init__(self) -> None:
                    self.saved_messages: list[dict[str, Any]] = []

                def save_chat_message(self, _cid: str, _title: str, _model: str, msg: dict[str, Any], **_kwargs: Any) -> dict[str, Any]:
                    self.saved_messages.append(msg)
                    return {"ok": True, "deduplicated": False}

                def sync_chat_state_mutations(self, **_kwargs: Any) -> dict[str, Any]:
                    return {
                        "ok": True,
                        "appliedCount": 1,
                        "materializedModules": ["svl-364"],
                        "serverRevision": 12,
                        "events": [{
                            "eventId": "evt-module-svl364",
                            "entity": "module",
                            "entityId": "svl-364",
                            "serverRevision": 12,
                        }],
                        "modules": [{"id": "svl-364", "name": "SVL-364", "revision": 4}],
                    }

                def list_conversations_with_messages(self) -> list[dict[str, Any]]:
                    return [{"id": "conv-test", "messages": self.saved_messages}]

            class FakeRuntime:
                def __init__(self) -> None:
                    self.kernel = FakeKernel()

                def apply_active_module_settings(self) -> None:
                    return None

            fake_runtime = FakeRuntime()
            body = {
                "conversation_id": "conv-test",
                "title": "Test",
                "model": "svl-hybrid-router",
                "eventId": "evt-user-test",
                "message": {
                    "id": "user-test",
                    "role": "user",
                    "sender": "Operator",
                    "content": "Skonfiguruj moduł SVL-364",
                    "timestamp": "04:00",
                },
            }
            with patch.object(backend_app, "runtime", fake_runtime):
                status, response = asyncio.run(
                    backend_app.handle_api_request(
                        "POST",
                        "/api/py/chat/conversations/message",
                        {},
                        body,
                    )
                )

            self.assertEqual(status, 200)
            self.assertEqual(len(fake_runtime.kernel.saved_messages), 2)
            report = fake_runtime.kernel.saved_messages[1]
            self.assertEqual(report["role"], "system")
            self.assertEqual(report["appliedActions"][0]["entityId"], "svl-364")
            self.assertEqual(response["conversations"][0]["messages"][1]["appliedActions"][0]["ok"], True)
            self.assertEqual(response["events"][0]["eventId"], "evt-module-svl364")


if __name__ == "__main__":
    unittest.main()
