# 04. Lokalny Demon Ollama (11434) i Terminale ROOT (`SVL-364`)

## 1. Wbudowany Demon Ollama (`backend/ollama_daemon.py`)

System automatycznie uruchamia lokalny serwer HTTP na `127.0.0.1:11434` (`SVLLocalOllamaDaemon`), jeśli w środowisku nie działa zewnętrzny proces Ollama, oraz instaluje wykonywalny skrypt CLI `ollama` w `/usr/local/bin/ollama` i `backend/bin/ollama`.

Obsługiwane endpointy:
- `GET /api/tags` — lista 4 zainstalowanych modeli lokalnych (`llama3.2-vision:11b`, `qwen2.5-coder:14b`, `dolphin-llama3:8b`, `bielik-11b-v2.3-instruct:q5_k_m`).
- `GET /api/ps` — lista modeli aktywnych w pamięci VRAM/RAM.
- `POST /api/pull` — natychmiastowa rejestracja/aktualizacja modelu.
- `POST /api/chat` oraz `POST /api/generate` — lokalne wnioskowanie zintegrowane z telemetrią `SVLSystemKernel`.

## 2. Terminale Systemowe i Zdalny SSH

Terminal **SSH · Ship** używa aliasu OpenSSH z `SVL_SSH_TARGET` (domyślnie `Ship`) i konfiguracji/uwierzytelniania konta uruchamiającego backendu. Host alias musi być skonfigurowany w `~/.ssh/config`; system nie generuje kluczy ani nie zakłada użytkownika `root`.

Każde polecenie w terminalu SSH wymaga potwierdzenia operatora i jest przekazywane jako polecenie powłoki na wskazany host. Połączenie działa bez PTY; brak SSH, błąd uwierzytelnienia lub nieznany host kończy się błędem — polecenie nigdy nie przełącza się na lokalny shell. Wywołania Ollama/MCP nie mogą uruchamiać poleceń SSH.

Pozostałe terminale (Linux, Python, Codex, hyperspace i agenci) zachowują swoje dotychczasowe lokalne funkcje. Polecenie `/exec raport systemu` nadal generuje raport `SVL_System`; nie jest specjalnie przechwytywane w terminalu SSH, gdzie każde wpisane polecenie trafia na host `Ship`.
