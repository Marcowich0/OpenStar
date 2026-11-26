#!/usr/bin/env bash
# Tests for check-pins.sh: the real repository passes, and a copy of its
# pinned files with one pin broken fails, naming the problem. Run by
# `just pins-check`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
guard="$root/scripts/check-pins.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
failures=0

# A fresh copy of every file the guard reads.
copy() {
  repo="$scratch/$1"
  mkdir -p "$repo/.github" "$repo/scripts" "$repo/e2e"
  cp "$root/Dockerfile" "$root/renovate.json" "$repo/"
  cp -r "$root/.github/workflows" "$repo/.github/"
  cp "$root/scripts/e2e.sh" "$repo/scripts/"
  cp "$root/e2e/package.json" "$repo/e2e/"
}

# expect <pass|fail> <case name> [text the output must contain]
expect() {
  local want="$1" name="$2" needle="${3:-}" out status=0
  out="$("$guard" "$repo" 2>&1)" || status=$?
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

repo="$root"
expect pass "the repository's own pins"

copy from-tag
sed -i 's|^FROM --platform=linux/amd64 debian:trixie-slim@sha256:[0-9a-f]*|FROM --platform=linux/amd64 debian:trixie-slim|' "$repo/Dockerfile"
expect fail "a base image without a digest" "debian:trixie-slim"

copy bridge-from-tag
sed -i 's|^FROM --platform=linux/amd64 debian:12@sha256:[0-9a-f]*|FROM --platform=linux/amd64 debian:12|' "$repo/Dockerfile"
expect fail "the Mic bridge base image without a digest" "debian:12"

copy action-tag
sed -i '0,/uses: actions\/checkout@[0-9a-f]\{40\}/s//uses: actions\/checkout@v7/' "$repo/.github/workflows/ci.yml"
expect fail "an action pinned by tag" "actions/checkout@v7"

copy action-no-comment
sed -i '0,/\(uses: actions\/checkout@[0-9a-f]\{40\}\) # v[0-9.]*/s//\1/' "$repo/.github/workflows/ci.yml"
expect fail "an action SHA without its version comment" "actions/checkout"

copy bare-version
sed -i '/^# renovate: datasource=npm depName=pnpm$/d' "$repo/Dockerfile"
expect fail "a _VERSION without a renovate comment" "PNPM_VERSION"

copy checksum-wrong-datasource
sed -i 's|^# renovate: datasource=github-release-attachments depName=denoland/deno|# renovate: datasource=github-releases depName=denoland/deno|' "$repo/Dockerfile"
expect fail "a checksum whose version Renovate would bump without it" "DENO_SHA256"

copy checksum-orphan
printf 'ARG EXTRA_SHA256=%064d\n' 0 >>"$repo/Dockerfile"
expect fail "a checksum with no pinned version above it" "EXTRA_SHA256"

copy dependabot
printf 'version: 2\nupdates: []\n' >"$repo/.github/dependabot.yml"
expect fail "Dependabot version updates" "dependabot"

copy playwright-apart
sed -i 's|"@playwright/test": "[^"]*"|"@playwright/test": "1.0.0"|' "$repo/e2e/package.json"
expect fail "the Playwright image and @playwright/test apart" "@playwright/test"

copy renovate-broken
printf '{ "extends": [' >"$repo/renovate.json"
expect fail "an unreadable renovate.json" "renovate.json"

if [[ $failures -ne 0 ]]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
