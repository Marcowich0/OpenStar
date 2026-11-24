# Throwaway measurement image: Ubuntu 26.04 + headless PipeWire + Playwright browsers.
FROM mcr.microsoft.com/playwright:v1.65.1-resolute

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      pipewire pipewire-pulse pipewire-bin wireplumber pulseaudio-utils \
      dbus dbus-user-session sox libpulse0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.65.1 >/dev/null
COPY run.sh setup-audio.sh measure.mjs page.html pa_multi.py control.sh ./
RUN chmod +x run.sh setup-audio.sh control.sh && chown -R pwuser:pwuser /work
USER pwuser
ENV XDG_RUNTIME_DIR=/tmp/xdg
CMD ["/work/run.sh"]
