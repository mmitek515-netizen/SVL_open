# SVL_open — wyłącznie Codex CLI i konto ChatGPT (Codespaces)

Nie jest wymagany stały IP, klucz OpenAI API ani usługa MCP HTTP. Frontend i backend muszą działać **w tym samym środowisku**, gdzie dostępne jest zalogowane `codex`.

```bash
cd SVL_open
git pull --ff-only origin main
codex login --device-auth  # tylko jeśli nie jesteś zalogowany
bash deploy/start-svl-codex-only.sh
```

Skrypt używa logowania przez `codex login status`, tworzy lokalne sekrety aplikacji w `~/.config/svl-open/local-codex.env` z uprawnieniami 0600, włącza tryb czatu i kolejki agentów przez Codex CLI oraz uruchamia aplikację na porcie 3000. Nie generuje płatnego klucza API. Nie jest to serwer w chmurze gwarantowany przez subskrypcję ChatGPT.

W Codespaces otwórz **Ports → 3000 → Open in Browser**. Ustaw port jako **Private**. Adres przekierowany może się zmieniać i nie wymaga stałego IP.

W trybie developerskim serwer nasłuchuje na interfejsach kontenera, aby podgląd hostowany (np. AI Studio) mógł się z nim połączyć. Używa `PORT`, jeśli platforma go ustawi; w przeciwnym razie używa portu 3000. W produkcji domyślnie pozostaje związany z `127.0.0.1`; `SVL_BIND_HOST` pozwala jawnie zmienić host.

W czacie wybierz silnik **Codex CLI · konto ChatGPT**, a w polu dostępu wpisz `SVL_CODEX_CHAT_ACCESS_TOKEN`. Dla panelu agentów, terminali i ręcznej synchronizacji GitHub użyj osobnego `SVL_OPERATOR_TOKEN`. Skrypt podaje komendę pozwalającą lokalnie odczytać oba sekrety. Nie wklejaj ich do GitHuba, AI Studio ani publicznych logów.

Wszystkie zadania tekstowe używają `--sandbox read-only`; odpowiedź AI ma status `ANSWER_READY`, który **nie jest dowodem zakończenia rzeczywistej operacji**. Jedno konto Codex CLI ma limity użytkowania; pięć agentów dzieli sesję, a zadania są szeregowane blokadą procesów.

**Google AI Studio** uruchamia odrębną kopię aplikacji i nie otrzymuje automatycznie sesji OAuth z GitHub Codespaces. Do korzystania z Codexa przez aplikację potrzebny jest runtime, w którym konto jest faktycznie zalogowane. Samo scalenie `main` nie udostępnia tej sesji.

Ten projekt ma też inne endpointy niż czat i terminal. Utrzymuj port prywatny; tokeny chronią określone wrażliwe operacje, a nie zastępują pełnego logowania do całej aplikacji.

**Instalacja pakietów:** skrypt sprawdza skrót `package.json` i obecnego pliku blokady zależności. Gdy pakiety zmienią się po `git pull` lub brakuje `tsx`/`vite`, zainstaluje zależności przed załadowaniem tokenów. Dla lockfile korzysta z `npm ci`, a bez niego z `npm install --no-audit --no-fund`. Nie uruchamia testów.


## Diagnostyka bez testów, bez stałego IP

Aby odczytać **rzeczywisty** stan działającego Codespace (zalogowanie ChatGPT OAuth, serwer Python, pięć workerów, ostatni błąd Codex CLI), uruchom w jego terminalu:

```bash
python3 deploy/svl-doctor.py
python3 deploy/svl-doctor.py --logs --limit 30
```

Narzędzie kontaktuje się wyłącznie z `127.0.0.1:3000`, korzysta z prywatnego pliku konfiguracji, nie uruchamia testów ani misji, nie restartuje procesu i nie drukuje tokenów. Gdy serwer działa na innym porcie, można użyć `--port 3001`. Raport rozróżnia commit GitHub od faktycznie wdrożonej wersji serwera. Ogranicz uprawnienia do prywatnego pliku konfiguracji do `0600`; w przeciwnym razie diagnostyka odmówi automatycznego odczytu poświadczeń.
