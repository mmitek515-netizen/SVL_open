# SVL_open — czat przez zalogowane konto Codex CLI (bez API i stałego IP)

Ten tryb **nie używa OpenAI API key, Gemini, MCP HTTP ani stałego IP**. Serwer aplikacji uruchamia proces `codex exec` w tym samym systemie, w którym uruchomiono `tsx server.ts`.

## Warunki

- Na **tym samym komputerze lub Codespace** musi być zainstalowane Codex CLI i wykonane logowanie ChatGPT OAuth przez `codex login --device-auth`. Logowanie w innym komputerze, kontenerze lub przeglądarce AI Studio nie jest współdzielone.
- Uruchomienie serwera i Codex CLI musi używać **tego samego użytkownika Linux oraz CODEX_HOME**. Nie trzeba konfigurować nowego IP, portu MCP ani płatnego OpenAI API.
- Jeżeli Google AI Studio uruchamia podgląd we własnym odizolowanym środowisku, **nie ma automatycznie dostępu do Codexa zalogowanego w GitHub Codespaces**. GitHub synchronizuje kod, a nie konta OAuth ani uruchomione procesy.
- Funkcja korzysta z limitu użytkowania zalogowanego konta ChatGPT/Codex CLI. Po wyczerpaniu limitu pojawi się błąd, a nie fikcyjna odpowiedź.

## Konfiguracja — Codespaces / Linux

```bash
cd /sciezka/do/SVL_open
codex login --device-auth
codex login status
# W prywatnym pliku .env (NIE w GitHubie):
SVL_CODEX_CHAT_ENABLED=true
SVL_CODEX_CHAT_ACCESS_TOKEN=<własny-losowy-sekret-minimum-32-znaki>
```

Sekret dostępu do czatu aplikacji można wygenerować lokalnie: `python3 -c 'import secrets; print(secrets.token_urlsafe(36))'`. **To nie jest klucz OpenAI** — chroni zalogowane konto Codex CLI przed użyciem przez nieuprawnionych użytkowników publicznego podglądu. Zapisz go wyłącznie w prywatnym `.env`.

Uruchom lokalny gateway z dotychczasową konfiguracją. W czacie wybierz `Codex CLI · konto ChatGPT`, a w polu `Dostęp SVL` podaj swój lokalny sekret. Pole jest przechowywane wyłącznie w pamięci bieżącego komponentu React, nie w localStorage ani SQLite.

Stan procesu i logowania pokazuje `GET /api/codex-chat/status`, a po wdrożeniu również Centrum Dowodzenia SVL-364. Wskazanie `ZALOGOWANY W RUNTIME` dotyczy wyłącznie procesu Codex CLI dostępnego dla działającego backendu.

## Zadania pięciu agentów przez Codex CLI

Jeżeli Ollama jest niedostępna, ustaw na **tym samym serwerze / Codespace** `SVL_CODEX_AGENTS_ENABLED=true` (oprócz `SVL_CODEX_CHAT_ENABLED=true`). Wypełnij prywatny `SVL_OPERATOR_TOKEN` o długości minimum 32 znaków. Zrestartuj backend. Następnie w Panelu Agentów wpisz token operatora i wyślij zadanie.

W tym trybie pięć procesów Aria, Alex, Astyria, Aurelius, Agata korzysta ze wspólnego zalogowania Codex CLI. Przed uruchomieniem sprawdzają `codex login status`; blokada plikowa nie dopuszcza do pięciu równoczesnych wywołań. Wynik zadania ma status `ANSWER_READY`: oznacza przygotowaną odpowiedź, **nie** potwierdza wykonania misji, modyfikacji systemu ani wdrożenia kodu.

Oprogramowanie uruchomione w osobnym AI Studio nadal nie będzie miało dostępu do lokalnego OAuth Codexa. Zmienne środowiskowe i dane logowania nie są kopiowane przez GitHub.

## Bezpieczeństwo i ograniczenia

- `SVL_CODEX_CHAT_ENABLED` jest domyślnie `false`. Włączenie wymaga prywatnego tokenu operatora długości minimum 32 znaków.
- Backend uruchamia Codex CLI z `--sandbox read-only` w pustym, tymczasowym katalogu bez projektu, bez API key i z ograniczeniami czasu, rozmiaru odpowiedzi oraz liczby równoczesnych żądań. Nie wystawia sesji OAuth przez MCP HTTP.
- Lokalny czat oraz pięć workerów używają wspólnej blokady `flock` (util-linux) dla tego samego użytkownika Linux. Nie potrzeba stałego IP. Gdy konto jest zajęte, serwer zgłasza stan zajętości zamiast uruchamiać równoległe generowanie.
- Szczegółowa diagnostyka zalogowania wymaga prywatnego tokenu operatora w nagłówku `X-SVL-Codex-Access`. Bez niego endpoint pokazuje jedynie ogólny stan konfiguracji.
- Tryb jest tekstowy. Nie deklaruje obsługi obrazów ani uruchomionych usług Ollama.
- Nie wklejaj `auth.json`, sekretu operatora ani kodów logowania urządzenia do czatu, logów lub repozytorium.
- Samo wgranie nowego commitu na GitHub **nie aktualizuje** automatycznie procesu AI Studio. Tam musi działać ta sama wersja backendu, mieć lokalnie Codex CLI i konto OAuth, co zwykle nie zachodzi.
