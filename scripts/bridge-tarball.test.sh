#!/usr/bin/env bash
# Tests for bridge-tarball.sh, the Mic bridge release tarball. Run by
# `just bridge-tarball-check` (part of `just check`). A shell script stands in
# for the bridge binary: it prints its build identifier for `--version`.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tarball="$here/bridge-tarball.sh"
install_dir="$here/../crates/mic-bridge/install"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

# check <what it shows> <command...>: ok when the command succeeds.
check() {
    local what="$1"
    shift
    if "$@"; then ok "$what"; else fail "$what"; fi
}

fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}
ok() { echo "ok: $*"; }

fake_bridge() {
    mkdir -p "$(dirname "$1")"
    # shellcheck disable=SC2016 # $1 is the fake binary's own argument
    printf '#!/bin/sh\n[ "$1" = --version ] && echo %s\n' "$2" >"$1"
    chmod 755 "$1"
}

# --- A release build -------------------------------------------------------
fake_bridge "$work/bin/openstar-mic-bridge" 1.4.0
"$tarball" "$work/bin/openstar-mic-bridge" "$install_dir" "$work/out" >"$work/stdout"

name=openstar-mic-bridge-1.4.0-x86_64-linux
listing="$(cd "$work/out" && ls -A)"
check "writes $name.tar.gz and its .sha256, nothing else (found: $listing)" \
    [ "$listing" = "$name.tar.gz"$'\n'"$name.tar.gz.sha256" ]

check "prints the tarball's path" [ "$(cat "$work/stdout")" = "$work/out/$name.tar.gz" ]

if (cd "$work/out" && sha256sum --check --strict --quiet "$name.tar.gz.sha256"); then
    ok "the .sha256 checks the tarball with sha256sum --check"
else
    fail "sha256sum --check fails on $name.tar.gz.sha256"
fi
read -r _ named <"$work/out/$name.tar.gz.sha256"
check "the .sha256 names the tarball without a folder (it names '$named')" [ "$named" = "$name.tar.gz" ]

entries="$(tar -tzvf "$work/out/$name.tar.gz" | awk '{print $1, $2, $6}')"
expected="drwxr-xr-x 0/0 $name/
-rwxr-xr-x 0/0 $name/openstar-mic-bridge
-rw-r--r-- 0/0 $name/openstar-mic-bridge.desktop
-rw-r--r-- 0/0 $name/openstar-mic-bridge.svg"
check "holds the binary, the .desktop file and the icon in one folder, owned by root" [ "$entries" = "$expected" ] ||
    printf 'tarball entries:\n%s\n' "$entries" >&2

mkdir "$work/unpacked"
tar -xzf "$work/out/$name.tar.gz" -C "$work/unpacked"
for f in openstar-mic-bridge.desktop openstar-mic-bridge.svg; do
    check "$f is the install folder's, unchanged" cmp -s "$install_dir/$f" "$work/unpacked/$name/$f"
done
check "the binary is the given one, unchanged" \
    cmp -s "$work/bin/openstar-mic-bridge" "$work/unpacked/$name/openstar-mic-bridge"

desktop="$work/unpacked/$name/openstar-mic-bridge.desktop"
if grep -qx 'Exec=openstar-mic-bridge' "$desktop" && grep -qx 'Icon=openstar-mic-bridge' "$desktop" &&
    grep -qx 'Type=Application' "$desktop"; then
    ok "the .desktop file starts openstar-mic-bridge from PATH with its icon"
else
    fail "the .desktop file is:"$'\n'"$(cat "$desktop")"
fi

# --- The same inputs give the same bytes ---------------------------------
touch -d '2001-02-03 04:05:06' "$work/bin/openstar-mic-bridge"
"$tarball" "$work/bin/openstar-mic-bridge" "$install_dir" "$work/again" >/dev/null
check "the tarball is the same byte for byte when built again (times are not kept)" \
    cmp -s "$work/out/$name.tar.gz" "$work/again/$name.tar.gz"

# --- Refusals --------------------------------------------------------------
fake_bridge "$work/bad/openstar-mic-bridge" "not a version"
if "$tarball" "$work/bad/openstar-mic-bridge" "$install_dir" "$work/bad-out" >/dev/null 2>&1; then
    fail "a binary whose --version is not a build identifier was packed"
else
    ok "refuses a binary whose --version is not a build identifier"
fi
check "and writes nothing then" [ -z "$(ls -A "$work/bad-out" 2>/dev/null)" ]

if "$tarball" "$work/missing" "$install_dir" "$work/missing-out" >/dev/null 2>&1; then
    fail "packed a binary that does not exist"
else
    ok "refuses a missing binary"
fi

if [ "$failures" -ne 0 ]; then
    echo "$failures bridge-tarball test(s) failed" >&2
    exit 1
fi
echo "bridge-tarball: all tests passed"
