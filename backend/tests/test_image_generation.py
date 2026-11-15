from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import image_generation
from image_generation import ComfyUIError, build_qwen_image_workflow, generate_qwen_image


class FakeResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.content


class ImageGenerationTests(unittest.TestCase):
    def test_workflow_uses_recommended_qwen_image_settings_and_prompt(self) -> None:
        workflow = build_qwen_image_workflow(
            "A red bicycle beside a tree",
            seed=123,
            width=768,
            height=1024,
        )

        self.assertEqual(workflow["4"]["inputs"]["prompt"], "A red bicycle beside a tree")
        self.assertEqual(workflow["5"]["inputs"], {"width": 768, "height": 1024, "batch_size": 1})
        self.assertEqual(workflow["7"]["inputs"]["steps"], 35)
        self.assertEqual(workflow["7"]["inputs"]["cfg"], 5.0)
        self.assertEqual(workflow["7"]["inputs"]["sampler_name"], "er_sde")

    def test_workflow_rejects_empty_or_out_of_range_prompts_and_dimensions(self) -> None:
        with self.assertRaises(ValueError):
            build_qwen_image_workflow(" ", seed=1)
        with self.assertRaises(ValueError):
            build_qwen_image_workflow("image", seed=1, width=1000)

    def test_generation_submits_polls_and_returns_saved_image(self) -> None:
        queued = {"prompt_id": "job-1"}
        history = {
            "job-1": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {"9": {"images": [{"filename": "result.png", "type": "output"}]}},
            }
        }
        with (
            patch.object(image_generation, "_request_json", side_effect=[queued, history]) as request_json,
            patch.object(image_generation.urllib.request, "urlopen", return_value=FakeResponse(b"\x89PNG")) as urlopen,
        ):
            result = generate_qwen_image(
                "http://comfyui:8188",
                "A red bicycle beside a tree",
                timeout=1,
                poll_interval=0,
            )

        self.assertEqual(result["prompt_id"], "job-1")
        self.assertEqual(
            result["image"],
            "data:image/png;base64," + base64.b64encode(b"\x89PNG").decode("ascii"),
        )
        self.assertEqual(request_json.call_args_list[0].args[0], "http://comfyui:8188/prompt")
        submitted_workflow = request_json.call_args_list[0].kwargs["payload"]["prompt"]
        self.assertEqual(submitted_workflow["4"]["inputs"]["prompt"], "A red bicycle beside a tree")
        self.assertEqual(urlopen.call_args.args[0].full_url, "http://comfyui:8188/view?filename=result.png&subfolder=&type=output")

    def test_comfyui_http_failures_are_reported(self) -> None:
        with patch.object(
            image_generation,
            "_request_json",
            side_effect=ComfyUIError("ComfyUI offline"),
        ):
            with self.assertRaisesRegex(ComfyUIError, "offline"):
                generate_qwen_image("http://comfyui:8188", "A test image", timeout=1, poll_interval=0)


if __name__ == "__main__":
    unittest.main()
