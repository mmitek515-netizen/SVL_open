from __future__ import annotations

import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import SVLBackendRuntime


class FakeKernel:
    def __init__(self) -> None:
        self.events: list[dict[str, object]] = []
        self.audit: list[tuple[object, ...]] = []

    def emit_sync_event(self, **event: object) -> dict[str, object]:
        self.events.append(event)
        return {
            "revision": 1,
            "serverRevision": 1,
            "event": event,
        }

    def get_sync_metadata(self) -> dict[str, int]:
        return {"serverRevision": 1}

    def record_audit(self, *args: object) -> None:
        self.audit.append(args)


class FakeResponse:
    def __init__(self, frames: list[dict[str, object]]) -> None:
        self.lines = [json.dumps(frame).encode("utf-8") + b"\n" for frame in frames]

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def __iter__(self):
        return iter(self.lines)


class OllamaPullTests(unittest.TestCase):
    def make_runtime(self) -> SVLBackendRuntime:
        runtime = SVLBackendRuntime.__new__(SVLBackendRuntime)
        runtime.kernel = FakeKernel()
        runtime.ollama_host = "http://127.0.0.1:11434"
        runtime._ollama_pull_lock = threading.RLock()
        runtime._ollama_pull_thread = None
        runtime.ollama_pull_state = {
            "active": True,
            "model": "llama3.2-vision:11b",
            "status": "Łączenie",
            "percent": 0.0,
            "error": None,
        }
        return runtime

    def test_pull_stream_records_progress_and_only_completes_on_success(self) -> None:
        runtime = self.make_runtime()
        response = FakeResponse([
            {"status": "downloading", "total": 100, "completed": 40},
            {"status": "success"},
        ])

        with patch("app.urllib.request.urlopen", return_value=response):
            runtime._run_ollama_pull(
                "llama3.2-vision:11b",
                runtime.ollama_host,
                "test-client",
                "corr-1",
            )

        self.assertFalse(runtime.ollama_pull_state["active"])
        self.assertEqual(runtime.ollama_pull_state["percent"], 100.0)
        self.assertIsNone(runtime.ollama_pull_state["error"])
        self.assertEqual(runtime.kernel.events[-1]["event_type"], "ollama.pull_completed")

    def test_pull_stream_error_is_visible_and_emits_failure(self) -> None:
        runtime = self.make_runtime()
        response = FakeResponse([{"error": "model not found"}])

        with patch("app.urllib.request.urlopen", return_value=response):
            runtime._run_ollama_pull(
                "missing-model:latest",
                runtime.ollama_host,
                "test-client",
                "corr-2",
            )

        self.assertFalse(runtime.ollama_pull_state["active"])
        self.assertIn("model not found", runtime.ollama_pull_state["error"])
        self.assertEqual(runtime.kernel.events[-1]["event_type"], "ollama.pull_failed")


if __name__ == "__main__":
    unittest.main()
