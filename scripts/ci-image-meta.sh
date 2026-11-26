#!/usr/bin/env bash
# What a CI run builds and publishes (docs/docker-image.md, "Publishing").
# Usage: scripts/ci-image-meta.sh <event name> <git ref> <commit sha>
# (GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA). Prints lines for $GITHUB_OUTPUT:
#
#   build_id          the build identifier the image must report: the same rule
#                     as crates/server/src/build_id.rs (X.Y.Z from refs/tags/vX.Y.Z,
#                     edge-<7 hex> from refs/heads/main, dev otherwise)
#   publish           true only for a push to main, a push of a vX.Y.Z tag and
#                     the weekly schedule on main; false for everything else,
#                     pull requests above all
#   release           true only for a pushed vX.Y.Z tag
#   no_cache_runtime  true only for the weekly schedule
#   tags              the image references to push, one per line (empty when
#                     publish is false)
#
# Anything it does not recognise publishes nothing.
set -euo pipefail

if [[ $# -ne 3 ]]; then
    echo "usage: ci-image-meta.sh <event name> <git ref> <commit sha>" >&2
    exit 2
fi
event="$1" ref="$2" sha="$3"
if [[ ! "$sha" =~ ^[0-9a-fA-F]{7,}$ ]]; then
    echo "ci-image-meta.sh: '$sha' is not a commit SHA" >&2
    exit 2
fi

repo=ghcr.io/marcowich0/openstar
short="$(printf '%s' "${sha:0:7}" | tr '[:upper:]' '[:lower:]')"
version_re='^refs/tags/v([0-9]+)\.([0-9]+)\.([0-9]+)$'

build_id=dev
if [[ "$ref" =~ $version_re ]]; then
    build_id="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
elif [[ "$ref" == refs/heads/main ]]; then
    build_id="edge-$short"
fi

publish=false release=false no_cache_runtime=false
tags=()
case "$event:$ref" in
    push:refs/heads/main)
        publish=true
        tags=("$repo:edge" "$repo:sha-$short")
        ;;
    push:refs/tags/v*)
        if [[ "$ref" =~ $version_re ]]; then
            publish=true release=true
            major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
            tags=("$repo:$build_id" "$repo:$major.$minor" "$repo:$major" "$repo:latest")
        fi
        ;;
    schedule:refs/heads/main)
        publish=true no_cache_runtime=true
        tags=("$repo:edge")
        ;;
esac

printf 'build_id=%s\npublish=%s\nrelease=%s\nno_cache_runtime=%s\n' \
    "$build_id" "$publish" "$release" "$no_cache_runtime"
echo 'tags<<OPENSTAR_TAGS'
for tag in "${tags[@]}"; do echo "$tag"; done
echo 'OPENSTAR_TAGS'
