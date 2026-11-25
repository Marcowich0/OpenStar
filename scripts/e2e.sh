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
# Needs Docker, ffmpeg, the openstar-harness binary (`just harness-build`) and
# e2e/node_modules (`just e2e-install`).
set -euo pipefail

# Keep in step with @playwright/test in e2e/package.json: the image's browsers
# belong to that exact version.
readonly PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="${CARGO_TARGET_DIR:-$root/target}/release/openstar"
harness="${CARGO_TARGET_DIR:-$root/target}/debug/openstar-harness"

[ -x "$binary" ] || { echo "e2e: $binary is missing: run 'just build' (or 'just e2e')" >&2; exit 1; }
[ -x "$harness" ] || { echo "e2e: $harness is missing: run 'just harness-build' (or 'just e2e')" >&2; exit 1; }
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
cleanup() {
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
rm -rf "$root/e2e/generated/mic"
"$harness" fake-mic "$root/e2e/generated/mic" >/dev/null

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
base_url="http://127.0.0.1:$port"

# A clean environment, so nothing from the developer's shell reaches the server.
env -i PATH="$PATH" HOME="$work" \
  OPENSTAR_PORT="$port" \
  OPENSTAR_APPDATA_DIR="$work/appdata" \
  OPENSTAR_SONGS_DIR="$work/songs" \
  OPENSTAR_ADMIN_PIN=1234 \
  OPENSTAR_YTDLP_AUTOUPDATE=false \
  OPENSTAR_USDB_BASE_URL=http://127.0.0.1:9 \
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

status=0
docker run --rm --init \
  --network host --ipc host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e CI="${CI:-}" \
  -e OPENSTAR_E2E_BASE_URL="$base_url" \
  -v "$root/e2e:/e2e" -w /e2e \
  "$PLAYWRIGHT_IMAGE" \
  node node_modules/@playwright/test/cli.js test "${update_args[@]}" "$@" || status=$?

if [ "$status" -ne 0 ]; then
  # Keep the server's log beside the report and traces (the CI artifact).
  mkdir -p "$root/e2e/test-results"
  cp "$work/openstar.log" "$root/e2e/test-results/openstar.log"
  echo "e2e: failed; report in e2e/playwright-report, traces and the server log in e2e/test-results" >&2
fi
exit "$status"
