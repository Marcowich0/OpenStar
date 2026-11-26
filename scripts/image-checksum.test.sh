#!/usr/bin/env bash
# Checks that the image build refuses a yt-dlp or Deno download whose
# checksum does not match: builds only the Dockerfile's `tools` stage with a
# wrong checksum for each tool, and expects the build to fail. Builds nothing
# into the local image store.
set -euo pipefail
cd "$(dirname "$0")/.."

wrong=0000000000000000000000000000000000000000000000000000000000000000
for arg in YTDLP_SHA256 DENO_SHA256; do
    if out="$(docker buildx build --platform linux/amd64 --target tools --build-arg "$arg=$wrong" \
        --progress plain --output type=cacheonly . 2>&1)"; then
        echo "image-checksum: FAIL: the build accepted a download with a wrong $arg" >&2
        exit 1
    fi
    # It must fail on the checksum, not on something else (the network).
    if [[ "$out" != *"computed checksum did NOT match"* ]]; then
        echo "$out" >&2
        echo "image-checksum: FAIL: the build with a wrong $arg failed, but not on the checksum" >&2
        exit 1
    fi
    echo "image-checksum: ok: a wrong $arg fails the build"
done
docker buildx build --platform linux/amd64 --target tools --output type=cacheonly . >/dev/null 2>&1 ||
    { echo "image-checksum: FAIL: the tools stage does not build with the pinned checksums" >&2; exit 1; }
echo "image-checksum: ok: the pinned checksums build"
