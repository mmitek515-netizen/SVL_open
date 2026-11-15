from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


DEFAULT_DIFFUSION_MODEL = "qwen-image-2.1-step90000-FP8-comfy.safetensors"
DEFAULT_TEXT_ENCODER = "qwen3vl_8b_int8_convrot.safetensors"
DEFAULT_VAE = "qwen_image_2.1_vae_bf16.safetensors"
CPU_IMAGE_ENGINE = "stable-diffusion.cpp"
DEFAULT_SD_CPP_BINARY = "data/tools/stable-diffusion.cpp/sd-cli"
DEFAULT_SD_CPP_MODEL = "data/models/sd_turbo_q4_0.gguf"
SD_TURBO_MODEL_NAME = "SD-Turbo GGUF Q4 (CPU)"
MIN_SD_TURBO_MEMORY_BYTES = 4 * 1024**3


class ImageGenerationError(RuntimeError):
    pass


class ImageEngineUnavailableError(ImageGenerationError):
    pass


class ComfyUIError(ImageGenerationError):
    pass


def configured_image_engine() -> str:
    engine = os.environ.get("SVL_IMAGE_ENGINE", "comfyui").strip().lower()
    if engine not in ("comfyui", CPU_IMAGE_ENGINE):
        raise ImageGenerationError(f"Nieobsługiwany silnik grafiki: {engine or '(pusty)'}")
    return engine


def image_engine_model() -> str:
    return SD_TURBO_MODEL_NAME if configured_image_engine() == CPU_IMAGE_ENGINE else "Qwen Image 2.1"


def _project_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    return path.resolve()


def _sd_cpp_binary_path() -> Path | None:
    binary = os.environ.get("SVL_SD_CPP_BINARY", DEFAULT_SD_CPP_BINARY).strip()
    if not binary:
        return None
    if "/" in binary or "\\" in binary:
        path = _project_path(binary)
        return path if path.is_file() and os.access(path, os.X_OK) else None
    resolved = shutil.which(binary)
    return Path(resolved) if resolved else None


def _sd_cpp_model_path() -> Path:
    return _project_path(os.environ.get("SVL_SD_CPP_MODEL", DEFAULT_SD_CPP_MODEL))


def _available_memory_bytes() -> int | None:
    available: int | None = None
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                available = int(line.split()[1]) * 1024
                break
    except (OSError, ValueError, IndexError):
        pass

    cgroup_files = (
        (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory.current")),
        (
            Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
            Path("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
        ),
    )
    for limit_path, current_path in cgroup_files:
        try:
            limit_text = limit_path.read_text(encoding="ascii").strip()
            if limit_text == "max":
                continue
            limit = int(limit_text)
            current = int(current_path.read_text(encoding="ascii").strip())
            if limit > 0 and limit < 2**60:
                cgroup_available = max(0, limit - current)
                available = cgroup_available if available is None else min(available, cgroup_available)
                break
        except (OSError, ValueError):
            continue
    return available


def _memory_message(available: int | None) -> str:
    if available is None:
        return "Nie można ustalić dostępnej pamięci RAM dla silnika CPU."
    available_gib = available / (1024**3)
    return (
        f"SD-Turbo Q4 wymaga co najmniej 4 GiB wolnej pamięci RAM; "
        f"dostępne jest {available_gib:.1f} GiB."
    )


def probe_image_engine(comfyui_url: str) -> dict[str, Any]:
    try:
        engine = configured_image_engine()
    except ImageGenerationError as exc:
        return {
            "engine": os.environ.get("SVL_IMAGE_ENGINE", "comfyui"),
            "model": None,
            "reachable": False,
            "error": str(exc),
        }

    if engine != CPU_IMAGE_ENGINE:
        return {
            **probe_comfyui(comfyui_url),
            "engine": engine,
            "model": "Qwen Image 2.1",
        }

    binary = _sd_cpp_binary_path()
    model = _sd_cpp_model_path()
    if not binary:
        error = "Nie znaleziono wykonywalnego sd-cli; uruchom deploy/install-sd-turbo-cpu.sh."
    elif not model.is_file():
        error = f"Nie znaleziono modelu SD-Turbo: {model}."
    else:
        available = _available_memory_bytes()
        error = None if available is not None and available >= MIN_SD_TURBO_MEMORY_BYTES else _memory_message(available)
    return {
        "host": str(binary) if binary else None,
        "engine": engine,
        "model": SD_TURBO_MODEL_NAME,
        "reachable": error is None,
        "error": error,
    }


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


def generate_sd_turbo_image(
    prompt: str,
    *,
    width: int = 512,
    height: int = 512,
    timeout: float = 900.0,
) -> dict[str, str]:
    if not prompt.strip():
        raise ValueError("Opis obrazu jest wymagany.")
    if len(prompt) > 4000:
        raise ValueError("Opis obrazu może mieć maksymalnie 4000 znaków.")
    if any(size < 256 or size > 512 or size % 64 for size in (width, height)):
        raise ValueError("SD-Turbo CPU obsługuje wymiary od 256 do 512, będące wielokrotnością 64.")

    available = _available_memory_bytes()
    if available is None or available < MIN_SD_TURBO_MEMORY_BYTES:
        raise ImageEngineUnavailableError(_memory_message(available))

    binary = _sd_cpp_binary_path()
    if not binary:
        raise ImageEngineUnavailableError(
            "Nie znaleziono wykonywalnego sd-cli; uruchom deploy/install-sd-turbo-cpu.sh."
        )
    model = _sd_cpp_model_path()
    if not model.is_file():
        raise ImageEngineUnavailableError(f"Nie znaleziono modelu SD-Turbo: {model}.")

    seed = uuid.uuid4().int % (2**32)
    with tempfile.TemporaryDirectory(prefix="svl-sd-turbo-") as temp_dir:
        image_path = Path(temp_dir) / "generated.png"
        command = [
            str(binary),
            "-m", str(model),
            "-p", prompt,
            "--steps", "4",
            "--cfg-scale", "1.0",
            "--sampling-method", "euler_a",
            "-W", str(width),
            "-H", str(height),
            "--seed", str(seed),
            "-o", str(image_path),
        ]
        process_env = {
            key: value
            for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
            if (value := os.environ.get(key))
        }
        try:
            process_env["LD_LIBRARY_PATH"] = str(binary.parent)
            result = subprocess.run(
                command,
                cwd=Path(__file__).resolve().parents[1],
                env=process_env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("Generowanie obrazu przez SD-Turbo CPU przekroczyło limit czasu.") from exc
        except OSError as exc:
            raise ImageEngineUnavailableError(f"Nie można uruchomić sd-cli: {exc}") from exc

        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()[-1000:]
            raise ImageGenerationError(
                "SD-Turbo CPU nie wygenerował obrazu."
                + (f" Szczegóły: {detail}" if detail else "")
            )
        if not image_path.is_file():
            raise ImageGenerationError("sd-cli zakończył pracę bez zapisania obrazu.")
        if image_path.stat().st_size > 25 * 1024 * 1024:
            raise ImageGenerationError("Wygenerowany obraz przekracza limit rozmiaru 25 MiB.")
        image_bytes = image_path.read_bytes()
        if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ImageGenerationError("sd-cli zwrócił plik, który nie jest poprawnym PNG.")

    return {
        "prompt_id": str(seed),
        "image": f"data:image/png;base64,{base64.b64encode(image_bytes).decode('ascii')}",
    }


def generate_image(
    comfyui_url: str,
    prompt: str,
    *,
    width: int | None = None,
    height: int | None = None,
) -> dict[str, str]:
    engine = configured_image_engine()
    if engine == CPU_IMAGE_ENGINE:
        return generate_sd_turbo_image(
            prompt,
            width=width if width is not None else 512,
            height=height if height is not None else 512,
        )
    return generate_qwen_image(
        comfyui_url,
        prompt,
        width=width if width is not None else 1024,
        height=height if height is not None else 1024,
    )
