# SVL_open — MCP po IP przez Codex CLI zalogowane kontem ChatGPT

## NAJPROSTSZY WARIANT: masz tylko zalogowany Codex CLI

Ten wariant działa w środowisku Linux, także w GitHub Codespaces, bez osobnego
klucza OpenAI API, roota, systemd i bez uruchamiania instalatora Debiana 13.
Wymaga Node.js 20+, Python 3 oraz już zalogowanego oficjalnego Codex CLI.

~~~bash
cd /sciezka/do/SVL_open
git pull --ff-only origin main

# Jeśli Codex nie jest jeszcze zalogowany:
codex login --device-auth
codex login status

# Używa bieżącego konta Linux i jego CODEX_HOME:
bash deploy/start-codex-mcp-cli.sh
~~~

Jeżeli jesteś już zalogowany, pomiń logowanie i po prostu uruchom skrypt.
Dopóki terminal z procesem Node jest aktywny, MCP działa pod
http://127.0.0.1:8787/mcp. Token ochronny MCP (NIE klucz OpenAI API)
generuje się sam i zostaje zapisany w ~/.config/svl-open-mcp/mcp-token
lub analogicznym katalogu XDG_CONFIG_HOME. Nie publikuj jego zawartości.

Na drugim urządzeniu w tej samej sieci najbezpieczniej użyć tunelu SSH:
~~~bash
ssh -N -L 8787:127.0.0.1:8787 user@IP_SERWERA
~~~
Po ustanowieniu tunelu endpoint jest dostępny lokalnie na
http://127.0.0.1:8787/mcp, z prywatnym nagłówkiem Bearer token.
Alternatywnie użyj VPN lub HTTPS reverse proxy.
Dostęp bezpośrednio przez publiczne IP i zwykłe HTTP jest niewskazany.

Dla Codex CLI jako **klienta** zdalnego serwera MCP:
~~~bash
export SVL_MCP_TOKEN='wartosc-tokena-przekazana-bezpiecznie'
codex mcp add svl-open \
  --url https://mcp.twoja-domena.example/mcp \
  --bearer-token-env-var SVL_MCP_TOKEN
codex mcp list
~~~

Dla klienta Codex działającego na tym samym hoście można użyć
http://127.0.0.1:8787/mcp zamiast adresu HTTPS.

## Architektura

Klient MCP (LAN / VPN / HTTPS)
  -> HTTP POST /mcp + Bearer SVL_MCP_TOKEN
  -> svl-codex-mcp.service (Node.js, użytkownik svlos)
      -> codex login status / codex exec --json
      -> CODEX_HOME=/var/lib/svl-os/codex (ChatGPT OAuth)
      -> Python SVLSystemKernel 127.0.0.1:8085 (agenci, SQLite, synchronizacja)

Integracja nie zamienia logowania ChatGPT w klucz OPENAI_API_KEY. 
Frontend SVL_open pozostaje na porcie 3000, Python na 8085, MCP na 8787.
Most MCP nie duplikuje bazy SQLite ani historii czatów i nie korzysta ze snapshotów.

## Narzędzia MCP

| Narzędzie | Funkcja | Tryb |
| --- | --- | --- |
| svl_sync_status | Rewizja synchronizacji z autorytatywnego backendu SQLite | odczyt |
| svl_agents_status | Nazwy i stany agentów (bez pamięci i sekretów) | odczyt |
| codex_status | Czy Codex CLI istnieje i czy sesja jest zalogowana | odczyt |
| codex_task | Zadanie Codex CLI w katalogu roboczym SVL_open | domyślnie odczyt, zapis opcjonalny |

## Instalacja na Debianie 13 (w rzeczywistym hoście SVL_open)

~~~bash
cd /sciezka/do/SVL_open
git pull --ff-only origin main
sudo npm install -g @openai/codex
sudo bash deploy/install-codex-mcp.sh

# Zaloguj dokładnie użytkownika usługi svlos:
sudo -u svlos env HOME=/var/lib/svl-os/svlos \
  CODEX_HOME=/var/lib/svl-os/codex \
  codex login --device-auth

sudo -u svlos env HOME=/var/lib/svl-os/svlos \
  CODEX_HOME=/var/lib/svl-os/codex \
  codex login status

sudo systemctl restart svl-codex-mcp.service
sudo systemctl status svl-codex-mcp.service --no-pager
~~~

Podczas device auth Codex wyświetli adres i kod; dokończ logowanie na swoim koncie ChatGPT.
Logowanie konta root albo innego użytkownika Codespace nie jest widoczne dla svlos.

Instalator generuje osobny silny token MCP w /etc/svl-os/svl-mcp.env (prawa 0600). 
Nie kopiuj tego tokenu ani pliku CODEX_HOME/auth.json do repozytorium, czatu lub frontendu.

## Lokalny test MCP po instalacji

~~~bash
sudo bash -c '
set -a
. /etc/svl-os/svl-mcp.env
set +a
curl -fsS http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $SVL_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '\''{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"svl-probe","version":"1"}}}'\''
'
~~~

Aby zobaczyć listę narzędzi: metoda tools/list. Aby sprawdzić logowanie: tools/call dla codex_status.
Aby zobaczyć rewizję systemu: tools/call dla svl_sync_status.

## Udostępnienie przez IP sieci LAN

Początkowo nasłuch na 127.0.0.1:8787. Dla zaufanej sieci lokalnej:

1. W /etc/svl-os/svl-mcp.env ustaw SVL_MCP_HOST=0.0.0.0 oraz SVL_MCP_ALLOW_REMOTE=true.
2. Ogranicz zaporą port 8787 do konkretnych adresów klientów, np.:
   sudo ufw allow from 192.168.1.20 to any port 8787 proto tcp
   (192.168.1.20 to wyłącznie przykład — zamień na prawdziwy adres).
3. Wykonaj sudo systemctl restart svl-codex-mcp.service.
4. Z klienta użyj http://IP_SERWERA:8787/mcp z nagłówkiem Authorization: Bearer i osobnym tokenem MCP.

Zwykłe HTTP po LAN może narazić token na przechwycenie; zalecany VPN, SSH tunnel
lub HTTPS reverse proxy. Nie wystawiaj portu 8787 otwarcie do internetu.

## Codex CLI jako klient zdalnego MCP

W środowisku klienta (token pobrany prywatnym, bezpiecznym kanałem):

~~~bash
export SVL_MCP_TOKEN='twoj-prywatny-token-MCP'
codex mcp add svl-open --url https://mcp.twoja-domena.example/mcp \
  --bearer-token-env-var SVL_MCP_TOKEN
codex mcp list
~~~

Adres .example jest schematem, NIE jest aktywnym serwerem.
Dla zdalnego dostępu stosuj prawdziwą domenę z HTTPS albo tunel.

## ChatGPT / Google AI Studio / Codespaces

- ChatGPT nie łączy się bezpośrednio z lokalnym IP. Wymaga publicznego HTTPS
  lub Secure MCP Tunnel. Możliwość podłączenia własnego MCP zależy od planu.
  Samo zalogowanie Codex CLI do konta ChatGPT nie tworzy wtyczki ChatGPT.
- Ten most ma Bearer token. Jeśli klient wymaga pełnego OAuth, potrzebna jest
  bramka OAuth lub zgodny bezpieczny tunel. Nie umieszczaj tokenu w adresie URL.
- Podgląd AI Studio nie musi udostępniać systemd, stabilnego konta Linux
  i trwałego CODEX_HOME. Uruchamiaj MCP na Debianie 13 lub skonfigurowanym
  środowisku Linux/Codespaces.
- Codex CLI działa z limitami właściwymi dla zalogowanego konta.
- W trybie zapisu Codex może zmieniać pliki dostępne dla użytkownika svlos.
  Domyślnie SVL_MCP_ENABLE_WRITE=false; nie włączaj zapisu dla niezaufanych klientów.

## Diagnostyka i testy

~~~bash
sudo journalctl -u svl-codex-mcp.service -n 80 --no-pager
sudo systemctl is-active svl-codex-mcp.service
sudo ss -lntp | grep 8787
npm run test:mcp
~~~

401 = brak poprawnego tokenu MCP.
403 = niedozwolony Origin (SVL_MCP_ALLOWED_ORIGINS).
Problem z uruchomieniem = sprawdź env, Node.js i dostępność pliku usługi.
codex_status.loggedIn=false = ponownie wykonaj device-auth jako svlos.
SVL backend offline = sprawdź proces Python na 127.0.0.1:8085 i SQLite.
Agenci offline = sprawdź niezależnie Ollama, workerów i lokalną magistralę.

Nie należy wnioskować, że agenci lub modele są online tylko dlatego,
że endpoint MCP odpowiada na initialize lub tools/list.
