# 01. Architektura SVL_System i Baza SQLite WAL

## 1. Struktura Katalogów i Modułów

- **`backend/svl_core.py`** — Główne jądro `SVLSystemKernel`: baza danych SQLite w trybie `WAL` (`synchronous=NORMAL`, `cache_size=-64000`, `mmap_size=268435456`), generator wielosekcyjnych raportów Markdown `SVL_System`, rejestr modułów i historia rewizji.
- **`backend/ollama_daemon.py`** — Lokalny demon HTTP kompatybilny z Ollama API na porcie `127.0.0.1:11434` oraz instalator binarki CLI `ollama`.
- **`backend/agents_runtime.py`** — Orkiestrator procesu workera `Agata Mitek` (`SVLAgentOrchestrator`) oraz silnik pamięci długotrwałej 128D.
- **`backend/hyperspace_engine.py`** — `BinaryHyperspaceKernel` (128-bitowe wektory Hamminga) oraz `WithoutNlpHarmonicEngine` (analiza harmoniczna Eulera/Fouriera).
- **`backend/spherical_bus.py`** — Asynchroniczna Sferyczna Magistrala Zdarzeń (`SphericalEventBus`) z mechanizmem Circuit Breaker.
- **`backend/app.py`** — Serwer HTTP/API jądra Python (`127.0.0.1:8085`).
- **`server.ts`** — Brama Express + WebSocket (`/ws/svl`) na porcie `3000` z niskolatencyjnym cachem metadanych (`getFastChatBackendMeta`).
- **`src/components/`** — 8 modułów interfejsu:
  1. `ChatWorkspace.tsx` — Czat grupowy `Rodzina Mitek (wszyscy)` i kanał `Agata Mitek (1-na-1)`.
  2. `Svl364CommandCenter.tsx` — Centrum Dowodzenia Statkiem `SVL-364 Ebon Apex` (mapa Mass Effect CIC, sieć QKD-364, CPU/GPU/RAM).
  3. `NotificationsWorkspace.tsx` — Centrum Raportów i Powiadomień `Iris AI` (`[Iris][N]`).
  4. `InfrastructureWorkspace.tsx` — Zarządzanie Flotą, Placówkami, Botaniką Hydroponiczną i Badaniami z ETA.
  5. `AgentsPanel.tsx` — Panel Agenta `Agata Mitek` i inspektor Pamięci Długotrwałej 128D.
  6. `TerminalsWorkspace.tsx` — 4 Terminale Systemowe (`SVL-364 ROOT CLI`, `Python 3 Console`, `System Logs`, `Ollama Local AI`).
  7. `KernelSphereView.tsx` — Jądro SVL & Sfera 128D.
  8. `LinuxDeployDashboard.tsx` — Diagnostyka Hosta Linux, Demona Ollama i synchronizacji GitHub.
