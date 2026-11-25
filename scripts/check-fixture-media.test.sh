#!/usr/bin/env bash
# Tests for check-fixture-media.sh: each case builds a throwaway git repo and
# runs the guard in it. Run by `just fixtures-check`.
set -euo pipefail

guard="$(cd "$(dirname "$0")" && pwd)/check-fixture-media.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
failures=0

# A minimal valid PCM WAV file (44-byte header, no samples).
wav() {
  mkdir -p "$(dirname "$1")"
  printf 'RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00' >"$1"
}

text() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "${2:-placeholder}" >"$1"
}

new_repo() {
  repo="$scratch/$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
}

stage() { git -C "$repo" add -A; }

# expect <pass|fail> <case name> [text the output must contain]
expect() {
  local want="$1" name="$2" needle="${3:-}" out status=0
  out="$(cd "$repo" && "$guard" 2>&1)" || status=$?
  if [[ "$want" == pass && $status -ne 0 ]] || [[ "$want" == fail && $status -eq 0 ]]; then
    echo "FAIL: $name: expected $want, got exit $status: $out" >&2
    failures=$((failures + 1))
  elif [[ -n "$needle" && "$out" != *"$needle"* ]]; then
    echo "FAIL: $name: output does not name '$needle': $out" >&2
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

new_repo no-fixtures
text "$repo/README.md"; stage
expect pass "a repo without fixtures/ passes"

new_repo data-only
text "$repo/fixtures/parser/minimal.txt" "#TITLE:Placeholder"
text "$repo/fixtures/readings/run.json" "[]"; stage
expect pass "data files under fixtures/ pass"

new_repo bare-audio
wav "$repo/fixtures/readings/run.wav"; stage
expect fail "audio without an attribution file fails" "fixtures/readings/run.wav"

new_repo attributed
text "$repo/fixtures/vocadito/ATTRIBUTION.md" "Vocadito, CC BY 4.0"
wav "$repo/fixtures/vocadito/excerpts/one.wav"
mkdir -p "$repo/fixtures/vocadito/excerpts"; cp "$repo/fixtures/vocadito/excerpts/one.wav" "$repo/fixtures/vocadito/two.FLAC"; stage
expect pass "audio below a directory with an attribution file passes"

new_repo sibling
text "$repo/fixtures/vocadito/ATTRIBUTION.md" "Vocadito, CC BY 4.0"
wav "$repo/fixtures/other/song.wav"; stage
expect fail "an attribution file covers only its own directory tree" "fixtures/other/song.wav"

new_repo root-attribution
text "$repo/fixtures/ATTRIBUTION.md" "covers everything?"
wav "$repo/fixtures/library/song.wav"; stage
expect fail "an attribution file directly in fixtures/ covers nothing" "fixtures/library/song.wav"

new_repo video-ext
text "$repo/fixtures/library/clip.MP4" "not really a video"; stage
expect fail "a video extension fails, whatever its case" "fixtures/library/clip.MP4"

new_repo renamed
wav "$repo/fixtures/readings/innocent.bin"; stage
expect fail "audio content under another extension fails" "fixtures/readings/innocent.bin"

new_repo untracked
wav "$repo/fixtures/library/song.ogg"
expect fail "an untracked, not ignored audio file fails before it is committed" "fixtures/library/song.ogg"

new_repo ignored
printf 'fixtures/library/generated/\n' >"$repo/.gitignore"
wav "$repo/fixtures/library/generated/song.wav"; stage
expect pass "generated media that git ignores passes"

new_repo outside
wav "$repo/web/public/beep.wav"; stage
expect pass "media outside fixtures/ is not this guard's business"

if [[ $failures -gt 0 ]]; then
  echo "$failures check-fixture-media case(s) failed" >&2
  exit 1
fi
