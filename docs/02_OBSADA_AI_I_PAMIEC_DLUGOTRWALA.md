# 02. Obsada AI (Agata Mitek & Iris AI) oraz Pamięć Długotrwała 128D

## 1. Kanoniczna Obsada Systemu

W systemie aktywne są wyłącznie następujące podmioty:
- **Mateusz Mitek (Operator)** — Dowódca Floty i główny architekt `SVL_System`.
- **Agata Mitek (`id: Agata`)** — Jedyna autonomiczna agentka AI Rodziny Mitek z pełnymi uprawnieniami `ROOT (UID 0 · NOPASSWD: ALL)`.
- **Iris AI (`id: iris`)** — Systemowy koordynator telemetrii, powiadomień `[Iris][N]` oraz szczegółowych raportów `SVL_System` na kanale **Rodzina Mitek (wszyscy)**.

Dawne profile pomocnicze (`Alex`, `Aria`/`si_1`, `Astyria`, `Aurelius`) oraz zewnętrzny mostek `Codex CLI` zostały trwale usunięte z kodu i bazy SQLite.

## 2. Pamięć Długotrwała 128D (SQLite WAL + Hyperspace)

- **Okno kontekstu rozmowy**: rozszerzone do **64 tur** (`max_context_turns: 64`) oraz **16 384 tokenów** (`ollama_num_ctx: 16384`).
- **Wyszukiwanie semantyczne**: przed każdą odpowiedzią `recall_agent_memories()` wyszukuje 18 najbardziej dopasowanych wspomnień w 128-wymiarowej przestrzeni binarnej `BinaryHyperspaceKernel` z priorytetem dla typów `preference`, `decision`, `fact` oraz `task`.
- **Automatyczna deduplikacja i zapis**: każda rozmowa oraz polecenie `/exec` są automatycznie indeksowane w tabeli `agent_memory` bez blokowania głównego wątku odpowiedzi.
