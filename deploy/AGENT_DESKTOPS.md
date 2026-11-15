# Local agent desktops

The optional `desktops` Compose profile provides five separate XFCE/noVNC sessions. Each container runs as UID/GID `10001`, drops Linux capabilities, has no host bind mounts, and can reach only its own isolated, internal Docker network. Desktops cannot reach each other, the backend, Ollama, or the public internet.

The desktop ports are bound to `127.0.0.1` only:

| Agent | Port |
| --- | ---: |
| Aria | 6081 |
| Alex | 6082 |
| Astyria | 6083 |
| Aurelius | 6084 |
| Agata | 6085 |

The Debian installer creates non-sudo `svl-*` host accounts and separate random VNC passwords in `/etc/svl-os/desktop-secrets/`. Start the stack and desktops with Docker Compose installed:

```bash
sudo sh -c 'set -a; . /etc/svl-os/svl.env; set +a; exec docker compose -f /opt/svl-python-os/deploy/docker-compose.yml --profile desktops up -d --build svl-python-backend ollama svl-desktop-aria svl-desktop-alex svl-desktop-astyria svl-desktop-aurelius svl-desktop-agata'
```

In the Agents panel, open a desktop and enter that agent's password from its corresponding file under `/etc/svl-os/desktop-secrets/` (read it with `sudo cat`). Do not expose ports 6081–6085 outside localhost. The profile does not grant agents shell access or let desktop processes control the host; GUI interaction remains operator-controlled.

The Python agent workers still inherit the backend service account's UID; the separate host accounts are not used to run those workers. This Compose profile isolates interactive desktop sessions, not worker execution. The desktops provide a local Linux GUI, not direct access to the SVL web backend.
