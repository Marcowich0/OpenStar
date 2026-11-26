#!/usr/bin/env bash
# Packs the Mic bridge for a GitHub release (docs/docker-image.md, "The Mic
# bridge"): `openstar-mic-bridge-<build id>-x86_64-linux.tar.gz`, holding one
# folder of that name with the binary, its `.desktop` file and its icon, and
# `<tarball>.sha256` beside it (`sha256sum --check` format).
#
# Usage: scripts/bridge-tarball.sh <bridge binary> <install folder> <out folder>
# The install folder is crates/mic-bridge/install. The build identifier comes
# from the binary's own `--version`, so the name always matches the binary.
# It runs in the Dockerfile's `bridge` stage; the same inputs give the same bytes.
# Prints the tarball's path.
set -euo pipefail

binary="${1:?usage: bridge-tarball.sh <bridge binary> <install folder> <out folder>}"
install_dir="${2:?usage: bridge-tarball.sh <bridge binary> <install folder> <out folder>}"
out="${3:?usage: bridge-tarball.sh <bridge binary> <install folder> <out folder>}"

[ -x "$binary" ] || { echo "bridge-tarball: $binary is not an executable file" >&2; exit 1; }
build_id="$("$binary" --version)"
# The build identifier rule (crates/server/src/build_id.rs).
if [[ ! "$build_id" =~ ^([0-9]+\.[0-9]+\.[0-9]+|edge-[0-9a-f]+|dev)$ ]]; then
    echo "bridge-tarball: $binary --version prints '$build_id', not a build identifier" >&2
    exit 1
fi

name="openstar-mic-bridge-$build_id-x86_64-linux"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
install -d -m 0755 "$stage/$name"
install -m 0755 "$binary" "$stage/$name/openstar-mic-bridge"
install -m 0644 "$install_dir/openstar-mic-bridge.desktop" "$install_dir/openstar-mic-bridge.svg" "$stage/$name/"

mkdir -p "$out"
# Fixed order, owner and times, and no name or time in the gzip header.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu \
    -C "$stage" -cf - "$name" | gzip -9 -n >"$out/$name.tar.gz"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
