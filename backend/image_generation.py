from __future__ import annotations

import base64
import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any


DEFAULT_DIFFUSION_MODEL = "qwen-image-2.1-step90000-FP8-comfy.safetensors"
DEFAULT_TEXT_ENCODER = "qwen3vl_8b_int8_convrot.safetensors"
DEFAULT_VAE = "qwen_image_2.1_vae_bf16.safetensors"


class ComfyUIError(RuntimeError):
    pass


def build_qwen_image_workflow(
    prompt: str,
    *,
    seed: int,
    width: int = 1024,
    height: int = 1024,
    diffusion_model: str = DEFAULT_DIFFUSION_MODEL,
) -> dict[str, dict[str, Any]]:
    if not prompt.strip():
        raise ValueError("Opis obrazu jest wymagany.")
    if len(prompt) > 4000:
        raise ValueError("Opis obrazu może mieć maksymalnie 4000 znaków.")
    if any(size < 512 or size > 1536 or size % 64 for size in (width, height)):
        raise ValueError("Szerokość i wysokość muszą być wielokrotnością 64 z zakresu 512–1536.")

    return {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": diffusion_model, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": DEFAULT_TEXT_ENCODER,
                "type": "qwen_image",
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": DEFAULT_VAE}},
        "4": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["2", 0],
                "prompt": prompt,
                "negative_prompt": " ",
                "resolution": max(width, height),
            },
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "6": {
            "class_type": "QwenImage21Cache",
            "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"},
        },
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["6", 0],
                "positive": ["4", 0],
                "negative": ["4", 1],
                "latent_image": ["5", 0],
                "seed": seed,
                "steps": 35,
                "cfg": 5.0,
                "sampler_name": "er_sde",
                "scheduler": "simple",
                "denoise": 1.0,
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": "svl_qwen_image"},
        },
    }


def _request_json(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data else {})},
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise ComfyUIError(f"ComfyUI zwróciło HTTP {exc.code}: {detail or exc.reason}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ComfyUIError(f"Nie można połączyć się z ComfyUI: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ComfyUIError("ComfyUI zwróciło nieprawidłową odpowiedź JSON.") from exc
    if not isinstance(result, dict):
        raise ComfyUIError("ComfyUI zwróciło nieoczekiwany format odpowiedzi.")
    return result


def probe_comfyui(base_url: str) -> dict[str, Any]:
    host = base_url.rstrip("/")
    try:
        stats = _request_json(f"{host}/system_stats", timeout=2.0)
    except ComfyUIError as exc:
        return {
            "host": host,
            "reachable": False,
            "model": DEFAULT_DIFFUSION_MODEL,
            "error": str(exc),
        }
    return {
        "host": host,
        "reachable": True,
        "model": DEFAULT_DIFFUSION_MODEL,
        "system": stats.get("system", {}),
        "error": None,
    }


def generate_qwen_image(
    base_url: str,
    prompt: str,
    *,
    width: int = 1024,
    height: int = 1024,
    timeout: float = 900.0,
    poll_interval: float = 2.0,
) -> dict[str, str]:
    workflow = build_qwen_image_workflow(
        prompt,
        seed=uuid.uuid4().int % (2**32),
        width=width,
        height=height,
    )
    host = base_url.rstrip("/")
    queued = _request_json(
        f"{host}/prompt",
        payload={"prompt": workflow, "client_id": str(uuid.uuid4())},
        timeout=30.0,
    )
    prompt_id = str(queued.get("prompt_id") or "")
    if not prompt_id:
        raise ComfyUIError(f"ComfyUI nie przyjęło zadania: {queued.get('error', 'brak prompt_id')}")

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        history = _request_json(
            f"{host}/history/{urllib.parse.quote(prompt_id, safe='')}",
            timeout=10.0,
        )
        entry = history.get(prompt_id)
        if isinstance(entry, dict):
            status = entry.get("status") or {}
            if status.get("status_str") == "error":
                raise ComfyUIError(f"ComfyUI nie wygenerowało obrazu: {status.get('messages', 'błąd workflow')}")
            outputs = entry.get("outputs") or {}
            images = [
                image
                for output in outputs.values()
                if isinstance(output, dict)
                for image in output.get("images", [])
                if isinstance(image, dict) and image.get("filename")
            ]
            if images:
                image_info = images[0]
                query = urllib.parse.urlencode({
                    "filename": image_info["filename"],
                    "subfolder": image_info.get("subfolder", ""),
                    "type": image_info.get("type", "output"),
                })
                image_request = urllib.request.Request(f"{host}/view?{query}")
                try:
                    with urllib.request.urlopen(image_request, timeout=30.0) as response:
                        image_bytes = response.read()
                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    raise ComfyUIError(f"Nie można pobrać obrazu z ComfyUI: {exc}") from exc
                mime_type = mimetypes.guess_type(str(image_info["filename"]))[0] or "image/png"
                return {
                    "prompt_id": prompt_id,
                    "image": f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}",
                }
        time.sleep(poll_interval)
    raise TimeoutError(f"ComfyUI nie zakończyło generowania w ciągu {int(timeout)} sekund.")
