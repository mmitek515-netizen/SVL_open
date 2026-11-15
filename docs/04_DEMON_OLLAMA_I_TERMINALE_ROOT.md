# 04. Lokalny Demon Ollama (11434) i Terminale ROOT (`SVL-364`)

## 1. Wbudowany Demon Ollama (`backend/ollama_daemon.py`)

System automatycznie uruchamia lokalny serwer HTTP na `127.0.0.1:11434` (`SVLLocalOllamaDaemon`), jeśli w środowisku nie działa zewnętrzny proces Ollama, oraz instaluje wykonywalny skrypt CLI `ollama` w `/usr/local/bin/ollama` i `backend/bin/ollama`.

Obsługiwane endpointy:
- `GET /api/tags` — lista 4 zainstalowanych modeli lokalnych (`llama3.2-vision:11b`, `qwen2.5-coder:14b`, `dolphin-llama3:8b`, `bielik-11b-v2.3-instruct:q5_k_m`).
- `GET /api/ps` — lista modeli aktywnych w pamięci VRAM/RAM.
- `POST /api/pull` — natychmiastowa rejestracja/aktualizacja modelu.
- `POST /api/chat` oraz `POST /api/generate` — lokalne wnioskowanie zintegrowane z telemetrią `SVLSystemKernel`.

## 2. Terminale Systemowe i Polecenie `/exec raport systemu`

Moduł **Terminale (4)** udostępnia:
1. **Terminal Statku SVL-364 (ROOT CLI)**
2. **Python 3 Console**
3. **System Logs**
4. **Ollama Local AI**

Wpisanie `/exec raport systemu` (w terminalu lub na czacie) natychmiast generuje wielosekcyjny raport `SVL_System` z telemetrią statku `SVL-364 Ebon Apex`, stanem floty, botaniki i badań, zapisuje go jako `COMPLETED` w SQLite i publikuje na kanale **Rodzina Mitek (wszyscy)** jako **Iris AI**.
