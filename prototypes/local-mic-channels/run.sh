#!/usr/bin/env bash
# Container entrypoint: headless PipeWire stack + Xvfb, then the Playwright measurement.
# Usage: run.sh [command...]   (default: node measure.mjs)
set -euo pipefail

if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  exec dbus-run-session -- "$0" "$@"
fi

log() { echo "[run] $*" >&2; }

# Optional experiment: disable PipeWire's channel remixing for PulseAudio clients
# (channels are then mapped by index instead of by position).
if [[ "${PW_PULSE_NO_CHANNELMIX:-0}" == 1 ]]; then
  mkdir -p ~/.config/pipewire/pipewire-pulse.conf.d
  echo 'stream.properties = { channelmix.disable = true }' \
    > ~/.config/pipewire/pipewire-pulse.conf.d/90-no-channelmix.conf
  log "pipewire-pulse: channelmix.disable = true"
fi

pipewire >/tmp/pipewire.log 2>&1 &
sleep 0.5
wireplumber >/tmp/wireplumber.log 2>&1 &
pipewire-pulse >/tmp/pipewire-pulse.log 2>&1 &

for _ in $(seq 50); do pactl info >/dev/null 2>&1 && break; sleep 0.2; done
pactl info | grep -E 'Server Name|Default Sample' >&2

./setup-audio.sh

# Optional experiment: pin the graph quantum (e.g. 256) — see README, concurrent remaps.
if [[ -n "${FORCE_QUANTUM:-}" ]]; then
  pw-metadata -n settings 0 clock.force-quantum "$FORCE_QUANTUM" >/dev/null
  log "clock.force-quantum = $FORCE_QUANTUM"
fi

Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
sleep 0.5

if [[ $# -gt 0 ]]; then
  "$@"
else
  node measure.mjs
fi
