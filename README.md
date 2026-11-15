# SVL Python OS v5.6 — Centrum Dowodzenia Statkiem SVL-364 Ebon Apex & Infrastruktura Floty

**SVL Python OS** to zintegrowane środowisko operacyjne łączące **Python 3 Kernel (`SVLSystemKernel`)**, **Długotrwałą Pamięć Semantyczną 128D (`BinaryHyperspaceKernel` + SQLite WAL)**, **Wbudowanego Demona Ollama (`127.0.0.1:11434`)**, **Centrum Dowodzenia Statkiem Kosmicznym `SVL-364 Ebon Apex`** (z holograficzną mapą w stylu Mass Effect CIC) oraz **Moduł Infrastruktury Floty, Placówek, Botaniki Hydroponicznej i Badań z ETA**.

---

## Spis Dokumentacji Systemowej (`/docs`)

1. **[01. Architektura SVL_System i Baza SQLite WAL](docs/01_ARCHITEKTURA_SVL_SYSTEM.md)**
   - Dwustronna synchronizacja w czasie rzeczywistym (`/ws/svl`), niskie opóźnienia i cache metadanych.
   - Matematyczne jądro topologiczne `TopologicalInfinityEngine` oraz `WithoutNlpHarmonicEngine`.
2. **[02. Obsada AI (Agata Mitek & Iris AI) oraz Pamięć Długotrwała 128D](docs/02_OBSADA_AI_I_PAMIEC_DLUGOTRWALA.md)**
   - Kanoniczna obsada: **Mateusz Mitek (Operator)**, **Agata Mitek (`id: Agata`, ROOT UID 0)** oraz **Iris AI (`id: iris`)**.
   - Semantyczna pamięć długotrwała 128D w SQLite WAL (okno 64 tur, `num_ctx: 16384`, automatyczna deduplikacja i ekstrakcja faktów/preferencji).
   - Wielosekcyjne raporty `SVL_System` na kanale **Rodzina Mitek (wszyscy)**.
3. **[03. Statek Kosmiczny SVL-364 Ebon Apex i Infrastruktura Floty](docs/03_STATEK_SVL_364_I_INFRASTRUKTURA_FLOTY.md)**
   - Holograficzna mapa taktyczna CIC (Mass Effect Galaxy Map), łącze kwantowe `QKD-364` oraz telemetria `CPU / GPU / RAM`.
   - Zarządzanie statkami floty, placówkami planetarnymi, bioreaktorami botanicznymi (`+830 L O2/h`) i projektami badawczymi z ETA.
4. **[04. Lokalny Demon Ollama (11434) i Terminale ROOT (`SVL-364`)](docs/04_DEMON_OLLAMA_I_TERMINALE_ROOT.md)**
   - Wbudowany serwer HTTP `127.0.0.1:11434` (`backend/ollama_daemon.py`) oraz binarka CLI `ollama`.
   - Obsługa komend `/exec raport systemu`, `/exec <polecenie>` i `@work` w 4 terminalach systemowych.

---

## Szybki Start i Testy

```bash
# Uruchomienie pełnego środowiska (Gateway + Python Kernel + Demon Ollama 11434)
npm run dev

# Testy jednostkowe TypeScript i Python Kernel
npm run test:unit
npm run test:python
```
