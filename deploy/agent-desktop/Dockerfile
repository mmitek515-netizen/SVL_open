FROM debian:13-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/agent \
    DISPLAY=:0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      dbus-x11 \
      firefox-esr \
      novnc \
      supervisor \
      websockify \
      xfce4 \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent --shell /bin/bash agent \
    && install -d -o agent -g agent -m 0700 /home/agent/.vnc

COPY supervisord.conf /etc/supervisor/conf.d/desktop.conf
COPY entrypoint.sh /usr/local/bin/desktop-entrypoint
RUN chmod 0755 /usr/local/bin/desktop-entrypoint

USER 10001:10001
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/desktop-entrypoint"]
