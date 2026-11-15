#!/bin/sh
set -eu

if [ -z "${DESKTOP_PASSWORD_FILE:-}" ] || [ ! -r "$DESKTOP_PASSWORD_FILE" ]; then
  echo "DESKTOP_PASSWORD_FILE must point to a readable desktop password secret." >&2
  exit 1
fi

password="$(cat "$DESKTOP_PASSWORD_FILE")"
if [ "${#password}" -lt 12 ]; then
  echo "Desktop password secret must contain at least 12 characters." >&2
  exit 1
fi

umask 077
mkdir -p "$HOME/.vnc"
x11vnc -storepasswd "$password" "$HOME/.vnc/passwd" >/dev/null
unset password

exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/desktop.conf
