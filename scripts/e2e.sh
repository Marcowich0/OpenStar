#!/usr/bin/env bash
# `just e2e`: runs the Playwright suite in e2e/ against the built binary.
#
# Starts target/release/openstar (built by `just build`, frontend embedded) on a
# free port of this machine, with a temporary appdata folder and the fixture
# Library (fixtures/library/, its audio generated from its Notes) in a
# temporary songs folder, writes the fake mic WAVs into e2e/generated/mic/,
# then runs Playwright from the pinned official Playwright Docker image on the
# host network, and stops everything afterwards. Extra arguments go to
# `playwright test` (for example a file name or `--grep`).
#
# The painter screenshot baselines (e2e/tests/__screenshots__/) are only ever
# written by `just update-screenshots`, which sets
# OPENSTAR_E2E_UPDATE_SCREENSHOTS=1; any other run compares against them and
# refuses Playwright's own update flags.
#
# Also starts the fake USDB (`openstar-harness fake-usdb`) and gives the
# server its fake credentials, so no browser test ever reaches the real USDB;
# Playwright reads and scripts the fake at OPENSTAR_E2E_USDB_URL. The fixture
# Song "Sine Melody" gets a metadata.json naming USDB id 900001
# (E2E_USDB_IN_LIBRARY_ID in e2e/fixtures.ts), so a USDB song can be "In
# Library".
#
# The server finds the yt-dlp stub (`openstar-harness ytdlp-stub`) first on
# its PATH, so the video picker's lookups never reach a video site.
#
# Also starts a headless Mic bridge (`openstar-mic-bridge --wav`) on the fake
# mic's 4-channel WAV, waiting for approval.
#
# Needs Docker, ffmpeg, the openstar-harness and openstar-mic-bridge binaries
# (`just harness-build`) and
# e2e/node_modules (`just e2e-install`).
set -euo pipefail

# Keep in step with @playwright/test in e2e/package.json: the image's browsers
# belong to that exact version.
readonly PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="${CARGO_TARGET_DIR:-$root/target}/release/openstar"
harness="${CARGO_TARGET_DIR:-$root/target}/debug/openstar-harness"
bridge="${CARGO_TARGET_DIR:-$root/target}/debug/openstar-mic-bridge"

[ -x "$binary" ] || { echo "e2e: $binary is missing: run 'just build' (or 'just e2e')" >&2; exit 1; }
[ -x "$harness" ] || { echo "e2e: $harness is missing: run 'just harness-build' (or 'just e2e')" >&2; exit 1; }
[ -x "$bridge" ] || { echo "e2e: $bridge is missing: run 'just harness-build' (or 'just e2e')" >&2; exit 1; }
[ -d "$root/e2e/node_modules" ] || { echo "e2e: e2e/node_modules is missing: run 'just e2e-install'" >&2; exit 1; }
[ -f "$root/e2e/generated/screenshot-page/sing-test.html" ] || { echo "e2e: the screenshot page is missing: run 'just screenshot-page' (or 'just e2e')" >&2; exit 1; }
command -v docker >/dev/null || { echo "e2e: docker is not installed; 'just e2e' runs Playwright in Docker" >&2; exit 1; }

update_args=()
for arg in "$@"; do
  case "$arg" in
    -u | --update-snapshots | --update-snapshots=*)
      echo "e2e: screenshot baselines change only through 'just update-screenshots'" >&2
      exit 2
      ;;
  esac
done
if [ "${OPENSTAR_E2E_UPDATE_SCREENSHOTS:-}" = "1" ]; then
  # Taken again from scratch, so a removed case leaves no stale image behind.
  rm -rf "$root/e2e/tests/__screenshots__"
  update_args=(--update-snapshots=all)
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/openstar-e2e.XXXXXX")"
server_pid=""
bridge_pid=""
usdb_pid=""
cleanup() {
  if [ -n "$usdb_pid" ]; then
    kill "$usdb_pid" 2>/dev/null || true
    wait "$usdb_pid" 2>/dev/null || true
  fi
  if [ -n "$bridge_pid" ]; then
    kill "$bridge_pid" 2>/dev/null || true
    wait "$bridge_pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

mkdir "$work/appdata"
# The fixture Library with its generated audio, and the fake mic WAVs the
# Phones' Chromium plays (e2e/ is mounted into the Playwright container).
"$harness" fixture-library "$work/songs" >/dev/null
echo '{"apiId": 900001}' >"$work/songs/Placeholder Artist - Sine Melody/metadata.json"
rm -rf "$root/e2e/generated/mic"
"$harness" fake-mic "$root/e2e/generated/mic" >/dev/null
"$harness" ytdlp-stub "$work/ytdlp" >/dev/null

# The Admin PIN of the server under test; the fixtures give it to become the Stage.
admin_pin=1234
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
base_url="http://127.0.0.1:$port"

# The fake USDB on a free port; its first stdout line is its base URL.
"$harness" fake-usdb >"$work/fake-usdb.out" 2>"$work/fake-usdb.log" &
usdb_pid=$!
usdb_url=""
for _ in $(seq 100); do
  usdb_url="$(head -n 1 "$work/fake-usdb.out" 2>/dev/null || true)"
  [ -n "$usdb_url" ] && break
  kill -0 "$usdb_pid" 2>/dev/null || break
  sleep 0.1
done
[ -n "$usdb_url" ] || { echo "e2e: the fake USDB did not start; its log:" >&2; cat "$work/fake-usdb.log" >&2; exit 1; }
echo "e2e: the fake USDB serves $usdb_url"

# A clean environment, so nothing from the developer's shell reaches the server.
env -i PATH="$work/ytdlp:$PATH" HOME="$work" \
  OPENSTAR_PORT="$port" \
  OPENSTAR_APPDATA_DIR="$work/appdata" \
  OPENSTAR_SONGS_DIR="$work/songs" \
  OPENSTAR_ADMIN_PIN="$admin_pin" \
  OPENSTAR_YTDLP_AUTOUPDATE=false \
  OPENSTAR_USDB_BASE_URL="$usdb_url" \
  OPENSTAR_USDB_USERNAME=fake-usdb-user \
  OPENSTAR_USDB_PASSWORD=fake-usdb-password \
  "$binary" >"$work/openstar.log" 2>&1 &
server_pid=$!

# Wait until the server answers, or give up when it exits or takes too long.
for _ in $(seq 300); do
  if curl -fsS -o /dev/null "$base_url/healthz" 2>/dev/null; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "e2e: openstar exited before it served; its log:" >&2
    cat "$work/openstar.log" >&2
    exit 1
  fi
  sleep 0.1
done
curl -fsS -o /dev/null "$base_url/healthz" || { echo "e2e: openstar did not answer $base_url/healthz" >&2; exit 1; }
echo "e2e: openstar serves $base_url"

# A Mic bridge on the fake mic's 4-channel WAV, waiting for the Stage to
# approve it (e2e/tests/mic-bridge.spec.ts), with its own config folder.
mkdir -p "$work/bridge-config/openstar-mic-bridge"
echo "$base_url" >"$work/bridge-config/openstar-mic-bridge/server"
env -i PATH="$PATH" HOME="$work" XDG_CONFIG_HOME="$work/bridge-config" \
  "$bridge" --wav "$root/e2e/generated/mic/multichannel.wav" >"$work/mic-bridge.log" 2>&1 &
bridge_pid=$!

status=0
docker run --rm --init \
  --network host --ipc host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e CI="${CI:-}" \
  -e OPENSTAR_E2E_BASE_URL="$base_url" \
  -e OPENSTAR_E2E_ADMIN_PIN="$admin_pin" \
  -e OPENSTAR_E2E_USDB_URL="$usdb_url" \
  -v "$root/e2e:/e2e" -w /e2e \
  "$PLAYWRIGHT_IMAGE" \
  node node_modules/@playwright/test/cli.js test "${update_args[@]}" "$@" || status=$?

if [ "$status" -ne 0 ]; then
  # Keep the server's log beside the report and traces (the CI artifact).
  mkdir -p "$root/e2e/test-results"
  cp "$work/openstar.log" "$root/e2e/test-results/openstar.log"
  cp "$work/mic-bridge.log" "$root/e2e/test-results/mic-bridge.log"
  cp "$work/fake-usdb.log" "$root/e2e/test-results/fake-usdb.log"
  echo "e2e: failed; report in e2e/playwright-report, traces and the server log in e2e/test-results" >&2
fi
exit "$status"
