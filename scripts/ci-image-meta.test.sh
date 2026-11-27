#!/usr/bin/env bash
# Tests for ci-image-meta.sh: what each CI event builds and publishes. Run by
# `just ci-meta-check`.
set -euo pipefail

meta="$(cd "$(dirname "$0")" && pwd)/ci-image-meta.sh"
failures=0
sha=0123abcDEF456789012345678901234567890abc
repo=ghcr.io/marcowich0/openstar

# expect <case name> <event> <ref> <expected output>
expect() {
    local name="$1" out status=0
    out="$("$meta" "$2" "$3" "$sha" 2>&1)" || status=$?
    if [[ $status -ne 0 || "$out" != "$4" ]]; then
        printf 'FAIL: %s (exit %s)\n--- expected\n%s\n--- got\n%s\n' "$name" "$status" "$4" "$out" >&2
        failures=$((failures + 1))
    else
        echo "ok: $name"
    fi
}

# expect_error <case name> <args...>
expect_error() {
    local name="$1" status=0
    shift
    "$meta" "$@" >/dev/null 2>&1 || status=$?
    if [[ $status -eq 0 ]]; then
        echo "FAIL: $name: expected an error" >&2
        failures=$((failures + 1))
    else
        echo "ok: $name"
    fi
}

no_publish() {
    printf 'build_id=%s\npublish=false\nrelease=false\nno_cache_runtime=false\ntags<<OPENSTAR_TAGS\nOPENSTAR_TAGS' "$1"
}

expect "a pull request publishes nothing" pull_request refs/pull/12/merge "$(no_publish dev)"
expect "a pull request from a branch named main publishes nothing" pull_request refs/heads/main "$(no_publish edge-0123abc)"
expect "a pull request with a version-looking ref publishes nothing" pull_request refs/tags/v1.2.3 "$(no_publish 1.2.3)"

expect "a push to main publishes :edge and :sha-<short>" push refs/heads/main "build_id=edge-0123abc
publish=true
release=false
no_cache_runtime=false
tags<<OPENSTAR_TAGS
$repo:edge
$repo:sha-0123abc
OPENSTAR_TAGS"

expect "a vX.Y.Z tag publishes X.Y.Z, X.Y, X and latest and makes a release" push refs/tags/v1.20.3 "build_id=1.20.3
publish=true
release=true
no_cache_runtime=false
tags<<OPENSTAR_TAGS
$repo:1.20.3
$repo:1.20
$repo:1
$repo:latest
OPENSTAR_TAGS"

expect "the weekly build on main rebuilds the runtime stage and publishes :edge only" schedule refs/heads/main "build_id=edge-0123abc
publish=true
release=false
no_cache_runtime=true
tags<<OPENSTAR_TAGS
$repo:edge
OPENSTAR_TAGS"

expect "a push to the integration branch publishes nothing" push refs/heads/integration/v1 "$(no_publish dev)"
expect "a push to another branch publishes nothing" push refs/heads/ticket/65 "$(no_publish dev)"
expect "a pre-release tag publishes nothing" push refs/tags/v1.2.3-rc1 "$(no_publish dev)"
expect "a two-part tag publishes nothing" push refs/tags/v1.2 "$(no_publish dev)"
expect "a tag without the v publishes nothing" push refs/tags/1.2.3 "$(no_publish dev)"
expect "a schedule on another branch publishes nothing" schedule refs/heads/integration/v1 "$(no_publish dev)"
expect "a manual dispatch publishes nothing" workflow_dispatch refs/heads/main "$(no_publish edge-0123abc)"
expect "a workflow_run publishes nothing" workflow_run refs/heads/main "$(no_publish edge-0123abc)"

expect_error "a missing argument is refused" push refs/heads/main
expect_error "a SHA that is not hex is refused" push refs/heads/main not-a-sha-at-all

if [[ $failures -ne 0 ]]; then
    echo "ci-image-meta.test.sh: $failures failing case(s)" >&2
    exit 1
fi
echo "ci-image-meta.test.sh: all cases passed"
