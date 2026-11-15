#!/usr/bin/env bash
# ============================================================================
# SVL PYTHON OS — DEBIAN 13 TRIXIE AUTOMATED INSTALLER
# Installs:
# - Python 3.12+ & venv (FastAPI, Pydantic, SQLAlchemy, WebSockets)
# - Local Ollama service + auto-detection of RAM/VRAM for ~14B Vision model
# - Official OpenAI Codex CLI (@openai/codex) with `codex login --device-auth` support
# - Dedicated Linux accounts & systemd unit for SVLSystemKernel & 5 Agents
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[BLAD] Uruchom instalator jako root (np. sudo ./deploy/install-debian13.sh)" >&2
  exit 1
fi

echo "=== [1/6] Weryfikacja systemu Debian 13 Trixie i zasobow sprzetowych ==="
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "Wykryty system: ${PRETTY_NAME:-Linux}"
fi

apt-get update -qq
apt-get install -y python3 python3-venv python3-pip sqlite3 curl git jq polkitd sudo nodejs npm

echo "=== [2/6] Tworzenie uzytkownikow systemowych dla SVL OS i 4 Agentow ==="
getent group svlos >/dev/null 2>&1 || addgroup --system svlos
for acct in svlos svl-aria svl-alex svl-astyria svl-aurelius svl-agata; do
  if ! getent passwd "$acct" >/dev/null 2>&1; then
    adduser --system --ingroup svlos --home "/var/lib/svl-os/$acct" --shell /bin/bash "$acct"
  fi
done

install -d -o svlos -g svlos -m 0750 /var/lib/svl-os /var/log/svl-os /etc/svl-os /opt/svl-python-os
install -d -o root -g root -m 0700 /etc/svl-os/desktop-secrets
for acct in aria alex astyria aurelius agata; do
  secret_file="/etc/svl-os/desktop-secrets/${acct}.password"
  if [ ! -f "$secret_file" ]; then
    python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$secret_file"
  fi
  chown root:root "$secret_file"
  chmod 0600 "$secret_file"
done
cp -r . /opt/svl-python-os/
chown -R svlos:svlos /opt/svl-python-os

echo "=== [3/6] Konfiguracja srodowiska Python 3.12 i sekretu SVL_OPERATOR_TOKEN ==="
python3 -m venv /opt/svl-python-os/venv
/opt/svl-python-os/venv/bin/pip install --upgrade pip
/opt/svl-python-os/venv/bin/pip install -r /opt/svl-python-os/backend/requirements.txt

if [ ! -f /etc/svl-os/svl.env ]; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  umask 027
  cat > /etc/svl-os/svl.env <<EOF
SVL_OPERATOR_TOKEN=${TOKEN}
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_PREFERRED_MODEL=llama3.2-vision:11b
SVL_SQLITE_PATH=/var/lib/svl-os/svl_os.sqlite3
EOF
  chown root:svlos /etc/svl-os/svl.env
  chmod 0640 /etc/svl-os/svl.env
  echo "Wygenerowano nowy 64-znakowy SVL_OPERATOR_TOKEN w /etc/svl-os/svl.env"
fi

for acct in aria alex astyria aurelius agata; do
key="SVL_DESKTOP_$(printf '%s' "$acct" | tr '[:lower:]' '[:upper:]')_PASSWORD_FILE"
value="/etc/svl-os/desktop-secrets/${acct}.password"
if ! grep -q "^${key}=" /etc/svl-os/svl.env; then
  printf '%s=%s\n' "$key" "$value" >> /etc/svl-os/svl.env
fi
done
chown root:svlos /etc/svl-os/svl.env
chmod 0640 /etc/svl-os/svl.env

echo "=== [4/6] Instalacja i konfiguracja lokalnego silnika Ollama ==="
if ! command -v ollama >/dev/null 2>&1; then
  # Keep aligned with Compose; newer Ollama currently rejects the model's mllama architecture.
  curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=0.24.0 sh
fi
systemctl enable --now ollama

set -a
. /etc/svl-os/svl.env
set +a
OLLAMA_MODEL="${OLLAMA_PREFERRED_MODEL:-llama3.2-vision:11b}"
echo "Pobieranie skonfigurowanego modelu Ollama: ${OLLAMA_MODEL}"
ollama pull "$OLLAMA_MODEL"

echo "=== [5/6] Instalacja oficjalnego OpenAI Codex CLI ==="
npm install -g @openai/codex || true
echo "Aby zalogowac Codex CLI przez konto ChatGPT (device flow), wykonaj: codex login --device-auth"

echo "=== [6/6] Rejestracja i uruchomienie uslugi systemd svl-python-os.service ==="
install -o root -g root -m 0644 /opt/svl-python-os/deploy/systemd/svl-python-os.service /etc/systemd/system/svl-python-os.service
systemctl daemon-reload
systemctl enable --now svl-python-os.service

echo "Instalacja SVL Python OS zakonczona pomyslnie!"
echo "Sprawdz status: systemctl status svl-python-os.service"
