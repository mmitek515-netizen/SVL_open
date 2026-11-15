#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
TOOLS_DIR="${PROJECT_ROOT}/data/tools"
ENGINE_DIR="${TOOLS_DIR}/stable-diffusion.cpp"
BINARY_FILE="${ENGINE_DIR}/sd-cli"
ARCHIVE_FILE="${TOOLS_DIR}/sd-master-b7a74e6-bin-Linux-Ubuntu-24.04-x86_64.zip"
ARCHIVE_PART="${ARCHIVE_FILE}.part"
MODEL_DIR="${PROJECT_ROOT}/data/models"
MODEL_FILE="${MODEL_DIR}/sd_turbo_q4_0.gguf"
PART_FILE="${MODEL_FILE}.part"
ENGINE_URL="https://github.com/leejet/stable-diffusion.cpp/releases/download/master-955-b7a74e6/sd-master-b7a74e6-bin-Linux-Ubuntu-24.04-x86_64.zip"
ENGINE_SIZE="26122695"
ENGINE_SHA256="c33577f8340dc1ac4212adac7def108ecc08e3047d8a3c2d460cc878eac0e78b"
MODEL_URL="https://huggingface.co/samoudi/sd-turbo-gguf/resolve/main/sd_turbo_q4_0.gguf"
MODEL_SIZE="1847909248"
MODEL_SHA256="d069ef2b2d3d5c2465662d706c242a1016db56163c109bd7e3008a94cdd00359"
MIN_FREE_BYTES="$((4 * 1024 * 1024 * 1024))"

for command in curl sha256sum unzip; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "[ERROR] Missing required command: ${command}" >&2
    exit 1
  fi
done

free_bytes="$(df -B1 --output=avail "${PROJECT_ROOT}" | tail -n 1 | tr -d '[:space:]')"
if [ "${free_bytes}" -lt "${MIN_FREE_BYTES}" ]; then
  echo "[ERROR] At least 4 GiB of free disk space is required; found ${free_bytes} bytes." >&2
  exit 1
fi

mkdir -p "${TOOLS_DIR}" "${MODEL_DIR}"

if [ -e "${ENGINE_DIR}" ] && [ ! -x "${BINARY_FILE}" ]; then
  echo "[ERROR] ${ENGINE_DIR} already exists without the expected sd-cli binary." >&2
  exit 1
fi

if [ ! -x "${BINARY_FILE}" ]; then
  if [ -f "${ARCHIVE_FILE}" ]; then
    if [ "$(stat -c %s "${ARCHIVE_FILE}")" != "${ENGINE_SIZE}" ] ||
      ! echo "${ENGINE_SHA256}  ${ARCHIVE_FILE}" | sha256sum --check --status; then
      echo "[ERROR] Existing stable-diffusion.cpp archive has invalid size or SHA-256." >&2
      exit 1
    fi
  else
    if [ -f "${ARCHIVE_PART}" ] && [ "$(stat -c %s "${ARCHIVE_PART}")" -gt "${ENGINE_SIZE}" ]; then
      echo "[ERROR] Partial engine archive is larger than expected: ${ARCHIVE_PART}" >&2
      exit 1
    fi
    if [ -f "${ARCHIVE_PART}" ] && [ "$(stat -c %s "${ARCHIVE_PART}")" -eq "${ENGINE_SIZE}" ]; then
      if ! echo "${ENGINE_SHA256}  ${ARCHIVE_PART}" | sha256sum --check --status; then
        echo "[ERROR] Completed partial engine archive failed SHA-256 verification." >&2
        exit 1
      fi
      mv "${ARCHIVE_PART}" "${ARCHIVE_FILE}"
    else
      echo "Downloading the pinned stable-diffusion.cpp CPU release..."
      resume_args=()
      if [ -f "${ARCHIVE_PART}" ]; then
        resume_args=(--continue-at -)
      fi
      curl --fail --location --retry 5 --retry-delay 2 "${resume_args[@]}" \
        --output "${ARCHIVE_PART}" "${ENGINE_URL}"
      if [ "$(stat -c %s "${ARCHIVE_PART}")" != "${ENGINE_SIZE}" ] ||
        ! echo "${ENGINE_SHA256}  ${ARCHIVE_PART}" | sha256sum --check --status; then
        echo "[ERROR] Downloaded stable-diffusion.cpp archive failed size or SHA-256 verification." >&2
        exit 1
      fi
      mv "${ARCHIVE_PART}" "${ARCHIVE_FILE}"
    fi
  fi

  mkdir -p "${ENGINE_DIR}"
  unzip -q "${ARCHIVE_FILE}" -d "${ENGINE_DIR}"
  chmod 0755 "${BINARY_FILE}"
  rm -f "${ARCHIVE_FILE}"
fi

if [ -f "${MODEL_FILE}" ]; then
  if [ "$(stat -c %s "${MODEL_FILE}")" != "${MODEL_SIZE}" ] ||
    ! echo "${MODEL_SHA256}  ${MODEL_FILE}" | sha256sum --check --status; then
    echo "[ERROR] Existing model file has an unexpected size or SHA-256: ${MODEL_FILE}" >&2
    exit 1
  fi
elif [ -f "${PART_FILE}" ] && [ "$(stat -c %s "${PART_FILE}")" -gt "${MODEL_SIZE}" ]; then
  echo "[ERROR] Partial model file is larger than expected: ${PART_FILE}" >&2
  exit 1
elif [ -f "${PART_FILE}" ] && [ "$(stat -c %s "${PART_FILE}")" -eq "${MODEL_SIZE}" ]; then
  if ! echo "${MODEL_SHA256}  ${PART_FILE}" | sha256sum --check --status; then
    echo "[ERROR] Completed partial model failed SHA-256 verification: ${PART_FILE}" >&2
    exit 1
  fi
  mv "${PART_FILE}" "${MODEL_FILE}"
else
  echo "Downloading SD-Turbo Q4 from Hugging Face..."
  resume_args=()
  if [ -f "${PART_FILE}" ]; then
    resume_args=(--continue-at -)
  fi
  curl --fail --location --retry 5 --retry-delay 2 "${resume_args[@]}" \
    --output "${PART_FILE}" "${MODEL_URL}"
  if [ "$(stat -c %s "${PART_FILE}")" != "${MODEL_SIZE}" ] ||
    ! echo "${MODEL_SHA256}  ${PART_FILE}" | sha256sum --check --status; then
    echo "[ERROR] Downloaded model failed size or SHA-256 verification: ${PART_FILE}" >&2
    exit 1
  fi
  mv "${PART_FILE}" "${MODEL_FILE}"
fi

LD_LIBRARY_PATH="${ENGINE_DIR}" "${BINARY_FILE}" --help >/dev/null
echo "CPU image engine and verified model installed."
echo "Set SVL_IMAGE_ENGINE=stable-diffusion.cpp in .env and restart the gateway."
echo "Model path: ${MODEL_FILE}"
