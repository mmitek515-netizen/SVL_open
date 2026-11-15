#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[BLAD] Uruchom jako root: sudo ./deploy/install-ai-engines.sh" >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[BLAD] Ten instalator wymaga hosta z NVIDIA GPU i sterownikiem nvidia-smi." >&2
  exit 1
fi
if ! command -v ollama >/dev/null 2>&1; then
  echo "[BLAD] Najpierw zainstaluj Ollama, np. przez ./deploy/install-debian13.sh." >&2
  exit 1
fi

free_disk_gb="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
if [ "${free_disk_gb:-0}" -lt 100 ]; then
  echo "[BLAD] Wymagane co najmniej 100 GB wolnego miejsca; jest ${free_disk_gb:-0} GB." >&2
  exit 1
fi

echo "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -n 1)"
echo "RAM: $(awk '/MemTotal/ {printf \"%.0f GB\", $2/1024/1024}' /proc/meminfo)"
if ! systemctl is-active --quiet ollama; then
  systemctl enable --now ollama
fi

MODEL_ROOT=/opt/svl-ai-models
LLM_DIR="${MODEL_ROOT}/llm"
COMFYUI_ROOT=/opt/svl-comfyui
COMFYUI_MODELS="${COMFYUI_ROOT}/models"
OLLAMA_MODEL=qwen3.8-27b-q5
COMFYUI_COMMIT=b0b743566f65daafc423b4fea8a2fbda94b3384a

if [ ! -d "${COMFYUI_ROOT}/.git" ]; then
  git init "${COMFYUI_ROOT}"
  git -C "${COMFYUI_ROOT}" remote add origin https://github.com/comfyanonymous/ComfyUI.git
  git -C "${COMFYUI_ROOT}" fetch --depth 1 origin "${COMFYUI_COMMIT}"
  git -C "${COMFYUI_ROOT}" checkout --detach FETCH_HEAD
elif [ "$(git -C "${COMFYUI_ROOT}" rev-parse HEAD)" != "${COMFYUI_COMMIT}" ]; then
  echo "[BLAD] /opt/svl-comfyui nie jest wersją ComfyUI przetestowaną dla workflow Qwen 2.1." >&2
  echo "Użyj czystej instalacji w /opt/svl-comfyui lub sprawdź wersję przed kontynuacją." >&2
  exit 1
fi

install -d -m 0755 "${LLM_DIR}" "${COMFYUI_MODELS}/diffusion_models" \
  "${COMFYUI_MODELS}/text_encoders" "${COMFYUI_MODELS}/vae"

download_model() {
  local url="$1"
  local target="$2"
  local expected_size="$3"
  local expected_sha="$4"

  if [ -f "${target}" ] && [ "$(stat -c %s "${target}")" -eq "${expected_size}" ]; then
    if echo "${expected_sha}  ${target}" | sha256sum --check --status; then
      echo "OK: ${target}"
      return
    fi
  fi
  if [ -f "${target}" ] && [ "$(stat -c %s "${target}")" -ge "${expected_size}" ]; then
    rm -f "${target}"
  fi
  echo "Pobieranie: ${target}"
  resume_args=()
  if [ -f "${target}" ]; then
    resume_args=(--continue-at -)
  fi
  curl --fail --location --retry 5 --retry-delay 2 "${resume_args[@]}" \
    --output "${target}" "${url}"
  if [ "$(stat -c %s "${target}")" -ne "${expected_size}" ] ||
    ! echo "${expected_sha}  ${target}" | sha256sum --check --status; then
    echo "[BLAD] Nieprawidłowy rozmiar lub SHA-256 pliku ${target}." >&2
    exit 1
  fi
}

download_model \
  "https://huggingface.co/DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF/resolve/main/Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-Q5_K_M.gguf" \
  "${LLM_DIR}/qwen3.8-27b-q5_k_m.gguf" \
  20730952288 \
  4132d28c31a79d948824aa259c71d82f67f5d1a66574bf35ed9bb962ccb33698

download_model \
  "https://huggingface.co/chatrlabs/Qwen-Image-2.1-Uncensored-Omni-Quantized/resolve/main/qwen-image-2.1-step90000-FP8-comfy.safetensors" \
  "${COMFYUI_MODELS}/diffusion_models/qwen-image-2.1-step90000-FP8-comfy.safetensors" \
  7116789419 \
  ff341f9485d8f8e57ea4dbb4817eac5f8fddfd3c95299b20b66e691732cd698e

download_model \
  "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/aacf31a6d48e707f352ecba714cee0680da3479b/text_encoders/qwen3vl_8b_int8_convrot.safetensors" \
  "${COMFYUI_MODELS}/text_encoders/qwen3vl_8b_int8_convrot.safetensors" \
  9350798360 \
  8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f

download_model \
  "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/aacf31a6d48e707f352ecba714cee0680da3479b/vae/qwen_image_2.1_vae_bf16.safetensors" \
  "${COMFYUI_MODELS}/vae/qwen_image_2.1_vae_bf16.safetensors" \
  675509688 \
  bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9

cat > "${LLM_DIR}/Modelfile" <<EOF
FROM ${LLM_DIR}/qwen3.8-27b-q5_k_m.gguf
PARAMETER num_ctx 32768
EOF
chmod 0644 "${LLM_DIR}/Modelfile" "${LLM_DIR}/qwen3.8-27b-q5_k_m.gguf"
ollama create "${OLLAMA_MODEL}" -f "${LLM_DIR}/Modelfile"
qwen_test_output="$(ollama run "${OLLAMA_MODEL}" "Odpowiedz krótko: QWEN_READY")"
if [ -z "${qwen_test_output}" ]; then
  echo "[BLAD] Qwen nie zwrócił odpowiedzi testowej." >&2
  exit 1
fi
echo "Test LLM zakończony: ${qwen_test_output:0:160}"

python3 -m venv "${COMFYUI_ROOT}/venv"
"${COMFYUI_ROOT}/venv/bin/pip" install --upgrade pip
"${COMFYUI_ROOT}/venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/cu128
"${COMFYUI_ROOT}/venv/bin/pip" install -r "${COMFYUI_ROOT}/requirements.txt"
install -d -o svlos -g svlos -m 0750 "${COMFYUI_ROOT}/output" "${COMFYUI_ROOT}/temp" "${COMFYUI_ROOT}/user"

install -o root -g root -m 0644 \
  "${SCRIPT_DIR}/systemd/svl-comfyui.service" \
  /etc/systemd/system/svl-comfyui.service

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  install -d -m 0755 "$(dirname "${file}")"
  touch "${file}"
  if grep -q "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

set_env_value /etc/svl-os/svl.env OLLAMA_PREFERRED_MODEL "${OLLAMA_MODEL}"
set_env_value /etc/svl-os/svl.env COMFYUI_HOST http://127.0.0.1:8188
set_env_value /etc/svl-os/svl.env SVL_AI_MODEL_DIR "${MODEL_ROOT}"
set_env_value "${PROJECT_ROOT}/.env" OLLAMA_PREFERRED_MODEL "${OLLAMA_MODEL}"
set_env_value "${PROJECT_ROOT}/.env" SVL_AI_MODEL_DIR "${MODEL_ROOT}"
set_env_value "${PROJECT_ROOT}/.env" COMFYUI_MODELS_PATH "${COMFYUI_MODELS}"
if [ -f /etc/svl-os/svl.env ]; then
  operator_token="$(sed -n 's/^SVL_OPERATOR_TOKEN=//p' /etc/svl-os/svl.env | tail -n 1 | tr -d '"')"
  if [ -n "${operator_token}" ]; then
    set_env_value "${PROJECT_ROOT}/.env" SVL_OPERATOR_TOKEN "${operator_token}"
  fi
fi
chmod 0640 /etc/svl-os/svl.env
chown root:svlos /etc/svl-os/svl.env
chmod 0600 "${PROJECT_ROOT}/.env"

systemctl daemon-reload
systemctl enable --now svl-comfyui.service
systemctl restart svl-python-os.service

echo "Oczekiwanie na ComfyUI..."
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:8188/system_stats >/dev/null; then
    break
  fi
  if [ "${attempt}" -eq 60 ]; then
    systemctl status svl-comfyui.service --no-pager || true
    echo "[BLAD] ComfyUI nie uruchomiło się. Sprawdź: journalctl -u svl-comfyui.service" >&2
    exit 1
  fi
  sleep 2
done

echo "Test generowania obrazu przez API SVL (może potrwać kilka minut)..."
response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT
curl --fail --silent --show-error --max-time 900 \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A simple red apple on a white background, studio product photography"}' \
  http://127.0.0.1:8085/api/py/images/generate \
  --output "${response_file}"
install -d -o svlos -g svlos -m 0750 /var/lib/svl-os/generated
python3 - "${response_file}" /var/lib/svl-os/generated/qwen-image-smoke-test.png <<'PY'
import base64
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as response_file:
    response = json.load(response_file)
if not response.get("ok") or not response.get("image", "").startswith("data:image/png;base64,"):
    raise SystemExit(f"Test obrazu nie powiódł się: {response.get('error', 'brak obrazu PNG')}")
image = base64.b64decode(response["image"].split(",", 1)[1], validate=True)
if not image.startswith(b"\x89PNG\r\n\x1a\n"):
    raise SystemExit("ComfyUI zwróciło dane, które nie są poprawnym PNG.")
with open(sys.argv[2], "wb") as output_file:
    output_file.write(image)
PY
chown svlos:svlos /var/lib/svl-os/generated/qwen-image-smoke-test.png

echo "Gotowe. Wygenerowany obraz testowy: /var/lib/svl-os/generated/qwen-image-smoke-test.png"
echo "ComfyUI: http://127.0.0.1:8188 | Ollama model: ${OLLAMA_MODEL}"
