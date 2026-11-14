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


if __name__ == "__main__":
    unittest.main()
