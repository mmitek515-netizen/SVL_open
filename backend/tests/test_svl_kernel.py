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
import math
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from hyperspace_engine import BinaryHyperspaceKernel, WithoutNlpHarmonicEngine
from spherical_bus import SphericalEventBus
from svl_core import SVLProtectedVariable, SVLSystemKernel, TopologicalInfinityEngine, VisualScope


from agents_runtime import CANONICAL_SVL_AGENTS, SVLAgentOrchestrator


class TestSVLKernelSuite(unittest.TestCase):
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

            self.assertEqual(set(CANONICAL_SVL_AGENTS.keys()), {"Aria", "Alex", "Astyria", "Aurelius"})
            self.assertEqual(orchestrator.agent_states["Aria"]["id"], "si_1")
            self.assertEqual(orchestrator.agent_states["Aria"]["config"]["ollama_model"], "llama3.2-vision:11b")

            updated = orchestrator.update_agent_config("Aria", {"temperature": 0.42, "ollama_model": "llama3.2-vision:11b"})
            self.assertAlmostEqual(updated["temperature"], 0.42)
            reloaded = orchestrator.get_agent_config("Aria")
            self.assertAlmostEqual(reloaded["temperature"], 0.42)

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
            self.assertEqual(len(synced), 2)
            conv1 = next(c for c in synced if c["id"] == "conv-sync-1")
            self.assertEqual([m["id"] for m in conv1["messages"]], ["m-1", "m-2"])

            kernel.delete_conversation("conv-sync-2")
            remaining = kernel.list_conversations_with_messages()
            self.assertEqual([c["id"] for c in remaining], ["conv-sync-1"])

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
            self.assertEqual(svl364["name"], "SVL-364 Ebon Apex")
            self.assertEqual(svl364["source"], "chat")
            self.assertEqual(svl364["config"].get("async_event_bus_buffer"), 500)

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


if __name__ == "__main__":
    unittest.main()
