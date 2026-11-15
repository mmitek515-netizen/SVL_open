import base64
import tempfile
import unittest
from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from ollama_daemon import SVLLocalOllamaDaemon
from real_vision_engine import (
    PREFERRED_VISION_MODEL,
    SVLRealVisionEngine,
    analyze_image_binary,
    generate_svl364_sensor_png_bytes,
)
from svl_core import SVLSystemKernel


class TestSVLRealVisionSuite(unittest.TestCase):
    def test_png_synthesis_and_binary_decoder(self) -> None:
        png_bytes = generate_svl364_sensor_png_bytes(160, 90, variant="svl364_l2_horizon")
        b64 = base64.b64encode(png_bytes).decode("ascii")
        metrics = analyze_image_binary(f"data:image/png;base64,{b64}")

        self.assertTrue(metrics["validBinary"])
        self.assertEqual(metrics["format"], "PNG")
        self.assertEqual(metrics["mimeType"], "image/png")
        self.assertEqual(metrics["width"], 160)
        self.assertEqual(metrics["height"], 90)
        self.assertEqual(metrics["resolution"], "160×90 px")
        self.assertEqual(len(metrics["sha256"]), 64)
        self.assertGreater(metrics["colorStats"]["luminance"], 10.0)

    def test_end_to_end_ollama_32_vision_analysis_and_sqlite_module(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_real_vision.sqlite3")
            kernel = SVLSystemKernel(
                db_path=db_file,
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            daemon = SVLLocalOllamaDaemon(kernel_Getter=lambda: kernel)
            daemon.start_if_needed()

            engine = SVLRealVisionEngine(kernel, daemon)
            status = engine.get_status()
            self.assertTrue(status["ok"])
            self.assertEqual(status["configuredModel"], PREFERRED_VISION_MODEL)
            self.assertIn("llama3.2-vision:11b", status["modelAliases"])

            result = engine.analyze_image(
                preset_id="svl364_l2_horizon",
                prompt="Przetestuj Real Vision na modelu llama3.2-vision:11b.",
                emit_to_chat=True,
                emit_to_iris=True,
            )
            self.assertTrue(result["ok"])
            record = result["record"]
            self.assertEqual(record["model"], "llama3.2-vision:11b")
            self.assertEqual(record["ollamaHttpStatus"], 200)
            self.assertEqual(record["binaryMetrics"]["format"], "PNG")
            self.assertEqual(record["binaryMetrics"]["width"], 320)
            self.assertEqual(record["binaryMetrics"]["height"], 180)
            self.assertIn("llama3.2-vision:11b", record["reportMarkdown"])

            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-real-vision", mods)
            self.assertEqual(mods["svl-real-vision"]["status"], "ACTIVE")
            self.assertEqual(mods["svl-real-vision"]["config"]["ollama_model"], "llama3.2-vision:11b")
            self.assertEqual(mods["svl-real-vision"]["config"]["last_test_status"], "PASSED")

    def test_antivirus_scanner_purges_rogue_modules_and_virus_chat_payloads(self) -> None:
        from antivirus_scanner import SVLAntivirusScanner

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test_svl_av.sqlite3"
            kernel = SVLSystemKernel(db_path=db_path)
            kernel.upsert_system_module(
                module_id="svl-ai-liaison",
                name="Aura Mitek",
                kind="rogue",
                status="ACTIVE",
                description="Unauthorized rogue module",
                config={},
                origin="test",
            )
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy — czat grupowy)",
                "test",
                {
                    "id": "asst-infected-test-1",
                    "role": "assistant",
                    "sender": "Agata Mitek",
                    "timestamp": "12:00",
                    "content": "[Error: FATAL-SHUTDOWN-IMMINENT] Core-Dump-Wipe Self-Erase-Sequence",
                },
                origin="test",
            )
            av = SVLAntivirusScanner(kernel)
            scan = av.scan_and_purge(emit_to_chat=False, emit_to_iris=False, origin="unit-test")
            self.assertTrue(scan["ok"])
            self.assertEqual(scan["status"], "CLEAN_VERIFIED")
            self.assertGreaterEqual(scan["threatsFoundAndPurged"], 2)
            self.assertGreaterEqual(len(scan["neutralizedThreats"]), 2)
            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertNotIn("svl-ai-liaison", mods)
            self.assertIn("svl-antivirus-scanner", mods)
            self.assertIn("svl-memory-shield", mods)
            self.assertIn("svl-364-repo-vault", mods)
            self.assertIn("svl-364-camera-feed", mods)


if __name__ == "__main__":
    unittest.main()

