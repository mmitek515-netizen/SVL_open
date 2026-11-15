# Uruchomienie oryginalnych agentów SVL_open

Profile agentów są zdefiniowane w `backend/agents_runtime.py`. Są to definicje oprogramowania, a nie osobne zdalne konta ani działające procesy. Po uruchomieniu aplikacji backend tworzy lokalne workery; zadania tekstowe mogą być wykonywane przez Codex CLI zalogowane kontem ChatGPT w tym samym środowisku Linux.

## Uruchomienie w Codespaces

1. Otwórz Codespace repozytorium `mmitek515-netizen/SVL_open` na gałęzi `main`.
2. Zaloguj Codex CLI w terminalu Codespaces: `codex login --device-auth`. Dokończ logowanie przez przeglądarkę i potwierdź status poleceniem `codex login status`.
3. Uruchom **`bash deploy/start-svl-with-mcp.sh`**. Jednym poleceniem uruchamia gateway SVL_open (port 3000) i prywatny MCP Codex (127.0.0.1:8787/mcp) z tym samym zalogowanym użytkownikiem. Skrypt tworzy prywatne tokeny poza repozytorium i ustawia `SVL_CODEX_AGENTS_ENABLED=true`. Tylko gdy MCP nie jest potrzebny, użyj `bash deploy/start-svl-codex-only.sh`.
4. W Codespaces otwórz port 3000 jako **Private**. W aplikacji wpisz token operatora uzyskany lokalnie z `~/.config/svl-open/local-codex.env` i wybierz **Podłącz moje AI**.
5. Sprawdź status panelu agentów: prawdziwy worker ma PID, świeży heartbeat oraz status `ONLINE_LOCAL_WORKER`. Sam profil `DEFINITION_READY` nie oznacza, że agent działa.
6. Wyślij Arii, Alexowi, Astyrii, Aureliusowi i Agacie zadanie analizy repozytorium. Zadania Codex są szeregowane, ponieważ korzystają z jednego konta i wspólnej blokady procesu.
7. Z innego terminala wykonaj `python3 deploy/svl-doctor.py --logs`. Raport wskaże rzeczywiste odpowiedzi `/mcp`, poprawność Bearer tokenu, listę narzędzi, stan logowania Codexa oraz czy gateway odmawia dostępu bez tokenu. Port 8787 pozostaw prywatny.

## Granice i bezpieczeństwo

- Google AI Studio nie dziedziczy sesji OAuth z Codespaces. Aplikacja i Codex CLI muszą działać na tym samym hoście.
- Adres przekierowanego portu Codespaces może się zmieniać; nie potrzeba stałego IP ani klucza OpenAI API.
- Agentowe zadania Codex działają w trybie `read-only`: mogą analizować i proponować zmiany, ale nie edytują repozytorium. Zmiany wykonuj jako osobne, przeglądane commity lub pull requesty.
- Zachowaj port jako prywatny. Nie umieszczaj tokenów w repozytorium, AI Studio, issue ani publicznych logach.
- Stan `ANSWER_READY` oznacza gotową odpowiedź, a nie wykonanie zmian w kodzie.

## Aktualna autoryzacja HTTP i synchronizacji

Po wprowadzeniu zmian bezpieczeństwa wpisz lokalny `SVL_OPERATOR_TOKEN` w górnym pasku aplikacji **🔒 SVL**. Brak tokenu nie daje już dostępu administracyjnego. Nie ma również wspólnego tokenu deweloperskiego; przy uruchomieniu bez pliku konfiguracyjnego gateway generuje losowy token tymczasowy, więc w Codespaces korzystaj ze skryptu startowego, który zapisuje prywatny token w `~/.config/svl-open/local-codex.env`. Poprzednia wersja mogła zostawić sekret w localStorage — nowy interfejs usuwa taki zapis. Token jest trzymany wyłącznie w pamięci bieżącej karty i używany do żądań API tego samego serwera. Zakładka Linux może użyć tego samego tokenu do odczytu kodu. Zdarzenia WebSocket również wymagają uwierzytelnienia operatora — dlatego po podaniu tokenu interfejs ponawia połączenie.

W polu silnika czatu `Codex CLI` wprowadź dodatkowo `SVL_CODEX_CHAT_ACCESS_TOKEN`; ten osobny sekret umożliwia odpowiedzi modelu oraz operacje historii czatu. Polecenia terminala, konfiguracja Ollamy i inne zadania administracyjne wymagają uprawnienia operatora. Nie umieszczaj tokenów w issue, PR ani AI Studio.
