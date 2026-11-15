# 03. Statek Kosmiczny SVL-364 Ebon Apex i Infrastruktura Floty

## 1. Moduł `SVL-364` (`Svl364CommandCenter.tsx`)

- **Holograficzna Mapa Taktyczna CIC (styl Mass Effect)**:
  - Wizualizuje przekaźnik masy `SOL-RELAY-01`, stację `Cytadela SVL-01`, układ słoneczny (9 obiektów) oraz aktualny wektor i pozycję statku flagowego **SVL-364 Ebon Apex** (`Sektor Sol-Terra · Orbita L2 · Przekaźnik Kwantowy Sol-Relay-01`, współrzędne `[+142.88, -19.42, +88.04] AU`).
- **Telemetria Pokładowa (CPU / GPU / RAM)**:
  - Wyświetla na żywo obciążenie procesora (`CPU`), akceleratora `NVIDIA H100 Tensor Core (24 GB VRAM)`, alokację pamięci `RAM`, moc reaktora fuzyjnego `He-3` (`99.4%`) oraz integralność tarcz kinetycznych (`100%`).
- **Dane Sieciowe Połączenia ze Statkiem (`QKD-364`)**:
  - Szyfrowany tunel kwantowy `Quantum Entanglement Mesh v5.5 (AES-512-GCM + QKD-364)`, przepustowość `14.8 Gbps / 12.4 Gbps`, latencja `0.42 ms`, `0.000%` strat pakietów.

## 2. Moduł `Infrastruktura` (`InfrastructureWorkspace.tsx`)

- **Flota Statków Kosmicznych (5 jednostek)** — telemetria reaktora, tarcz, hull, CPU/GPU/RAM, lokalizacja, misja i ETA.
- **Placówki Planetarne i Stacje Orbitalne (5 baz)** — populacja, załoga AI, produkcja energii i status obrony.
- **Botanika & Bioreaktory Hydroponiczne (4 sekcje)** — produkcja tlenu (`+830 L O2/h`), wilgotność, spektrum LED, postęp wzrostu i ETA zbiorów.
- **Badania Naukowe & Projekty R&D (4 projekty)** — kierownik badań, postęp `%`, priorytet i ETA ukończenia.
