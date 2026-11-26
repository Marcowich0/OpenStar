# OpenStar's commands. CI runs only `just ci`; run `just check` before you push.

set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

# Every fast check: Rust, dependency licences and advisories, TypeScript,
# Prettier, the generated-types drift check and the fixture rules.
check: rust-check deny-check web-check e2e-check format-check drift-check fixtures-check ci-meta-check pins-check shell-check bridge-tarball-check compose-check

# What CI runs: every fast check, then the browser end-to-end tests.
ci: check e2e

# The browser end-to-end tests: builds the release binary with its frontend,
# serves it with a temporary appdata and Library, and runs Playwright on Chromium
# from the pinned Playwright Docker image (scripts/e2e.sh). The Library is the
# fixture Library with its audio generated, and the fake mic WAVs land in
# e2e/generated/mic/ (both need ffmpeg). Needs Docker.
# Arguments go to `playwright test`, e.g. `just e2e tests/tracer.spec.ts`.
# The painter screenshots compare against the committed baselines in
# e2e/tests/__screenshots__/ and never write them.
e2e *args: build harness-build e2e-install screenshot-page
    scripts/e2e.sh {{ args }}

# The only command that writes the screenshot baselines: the Mic bridge
# window's (crates/mic-bridge/tests/snapshots/, drawn on the CPU, no display)
# and the painter's (e2e/tests/__screenshots__/, deleted and taken again in
# the same pinned Playwright image as `just e2e`). Commit the changed images;
# the PR shows them.
update-screenshots: update-bridge-screenshots build harness-build e2e-install screenshot-page
    OPENSTAR_E2E_UPDATE_SCREENSHOTS=1 scripts/e2e.sh tests/painter.spec.ts

# The Mic bridge window's baselines alone (part of `just update-screenshots`;
# `cargo test` compares against them and refuses to write them otherwise).
update-bridge-screenshots:
    rm -f crates/mic-bridge/tests/snapshots/*.png
    UPDATE_SNAPSHOTS=force OPENSTAR_UPDATE_SCREENSHOTS=1 cargo test --locked -p openstar-mic-bridge --test window

# The test-only painter screenshot page (web/sing-test.html), built into
# e2e/generated/screenshot-page/; never part of the production build.
screenshot-page: web-install wasm
    pnpm --dir web exec vite build --mode screenshots --logLevel warn

# The openstar-harness binary `just e2e` uses (fixture Library, fake mic WAVs),
# and the Mic bridge it runs headless.
harness-build:
    cargo build --locked -p openstar-test-harness --bin openstar-harness -p openstar-mic-bridge --bin openstar-mic-bridge

e2e-install:
    pnpm --dir e2e install --frozen-lockfile

# Lint and type-check the end-to-end suite (it runs only in `just e2e`).
e2e-check: e2e-install
    pnpm --dir e2e lint
    pnpm --dir e2e typecheck

# Format, lint and test the whole Cargo workspace.
rust-check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --locked

# Fail on a dependency with a licence deny.toml does not allow, or with a
# RustSec advisory. Needs cargo-deny (see the CI workflow for the pinned version).
deny-check:
    cargo deny --locked check licenses advisories

# Prettier over every file type it knows in the repo (.prettierignore lists the
# exceptions). Rust is formatted by rustfmt in rust-check.
format-check: web-install
    web/node_modules/.bin/prettier --check .

# Format everything: rustfmt and Prettier.
fmt: web-install
    cargo fmt --all
    web/node_modules/.bin/prettier --write .

# Refuse audio or video under fixtures/ outside a directory with an
# ATTRIBUTION.md (fixtures/README.md has the rules), after testing the guard.
fixtures-check:
    scripts/check-fixture-media.test.sh >/dev/null
    scripts/check-fixture-media.sh

# The detector as WASM (crates/detector-wasm) for the pitch-detection
# AudioWorklet, into web/wasm/ (git-ignored), where Vitest and the Vite build
# take it from. The wasm32 target is pinned in rust-toolchain.toml.
wasm:
    cargo build --release --locked --target wasm32-unknown-unknown -p openstar-detector-wasm
    install -D -m 0644 "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/openstar_detector_wasm.wasm" web/wasm/openstar_detector.wasm

# Lint, type-check and test the frontend (Vitest runs the WASM build).
web-check: web-install wasm
    pnpm --dir web lint
    pnpm --dir web typecheck
    pnpm --dir web test

# Regenerate the TypeScript types from the Rust types and fail if they differ
# from the committed ones (changed, added or removed files).
drift-check:
    rm -rf web/src/generated
    cargo test --locked -p openstar-protocol export_bindings --quiet
    git diff --exit-code -- web/src/generated || { echo "web/src/generated is out of date: run 'just types' and commit the result" >&2; exit 1; }
    untracked="$(git ls-files --others --exclude-standard -- web/src/generated)"; \
    if [ -n "$untracked" ]; then echo "new generated types are not committed: $untracked" >&2; exit 1; fi

# Regenerate the TypeScript types from the Rust types.
types:
    rm -rf web/src/generated
    cargo test --locked -p openstar-protocol export_bindings --quiet

web-install:
    pnpm --dir web install --frozen-lockfile

# Build the frontend into web/dist (with the detector WASM module).
web-build: web-install wasm
    pnpm --dir web build

# Build the release binary with the frontend embedded (target/release/openstar).
build: web-build
    cargo build --release --locked -p openstar

# Build the Docker image (Dockerfile, docs/docker-image.md) into the local
# image store as `tag`, with the given build identifier. Needs Docker with buildx.
image tag="openstar:local" build_id="dev":
    docker buildx build --platform linux/amd64 --build-arg OPENSTAR_BUILD_ID={{ build_id }} --load -t {{ tag }} .

# Smoke-test a built image: what it holds, its user, volumes and HEALTHCHECK,
# that it starts as 1000:1000 and as 99:100, and that the Mic bridge it serves
# is of its build and starts headless on this machine. Then check that a wrong
# yt-dlp or Deno checksum fails the build.
image-smoke tag="openstar:local" build_id="dev":
    scripts/image-smoke.sh {{ tag }} {{ build_id }}
    scripts/image-checksum.test.sh

# The owner's pre-release check on a real Library (release checklist item 1):
# parses every Song text under `path` with the Library's parser and checks
# that writing it unedited gives back the same bytes, in memory. Never writes
# into the Library. Lists crashes, mismatches (with the first line that
# differs) and rejects (with their reasons), then the counts; fails on any
# crash or mismatch. Never run by `just check`, `just ci` or CI.
# A relative `path` is taken from the directory `just` was called in.
corpus path:
    library="$(cd {{ quote(invocation_directory()) }} && realpath -- {{ quote(path) }})"; \
    cargo run --release --locked -p openstar -- corpus "$library"

# Run the server on OPENSTAR_PORT (default 8080) with ./.appdata and ./.songs.
run: web-build
    mkdir -p .appdata .songs
    OPENSTAR_APPDATA_DIR="${OPENSTAR_APPDATA_DIR:-$PWD/.appdata}" OPENSTAR_SONGS_DIR="${OPENSTAR_SONGS_DIR:-$PWD/.songs}" cargo run -p openstar

# The Mic bridge install script must stay POSIX sh: it runs as
# `curl … | sh` on whatever /bin/sh a desktop has. ShellCheck comes with the
# CI runner image; on a desktop, install it from the distro.
shell-check:
    shellcheck --shell=sh crates/mic-bridge/install/install.sh

# Test the Mic bridge release tarball's packer (scripts/bridge-tarball.sh,
# run in the Dockerfile's `bridge` stage): its name, contents and checksum.
bridge-tarball-check:
    scripts/bridge-tarball.test.sh >/dev/null

# The Mic bridge release files (`openstar-mic-bridge-<build id>-x86_64-linux.tar.gz`
# and its .sha256) from the Dockerfile's `bridge` stage, into `dir`. CI runs
# this for a vX.Y.Z release; the tarball holds the same binary as the image.
bridge-release dir="target/bridge-release" build_id="dev":
    docker buildx build --platform linux/amd64 --build-arg OPENSTAR_BUILD_ID={{ build_id }} --target bridge-release --output type=local,dest={{ dir }} .

# Test what each CI event builds and publishes (scripts/ci-image-meta.sh,
# used by .github/workflows/ci.yml): only main, vX.Y.Z tags and the weekly
# schedule publish; pull requests never do.
ci-meta-check:
    scripts/ci-image-meta.test.sh >/dev/null

# The compose examples (compose.yaml, compose.caddy.yaml) pass
# `docker compose config` and hold what docs/deployment.md promises, and the
# docs' settings table names every setting the server reads
# (scripts/compose-check.sh). Needs Docker with the compose plugin, and jq.
compose-check:
    scripts/compose-check.sh

# Every version pin is one Renovate keeps current (scripts/check-pins.sh,
# docs/renovate.md): base images by digest, actions by SHA, a `# renovate:`
# comment on every `*_VERSION`, checksums that move with their version, and
# the Playwright image in step with @playwright/test.
pins-check:
    scripts/check-pins.test.sh >/dev/null
    scripts/check-pins.sh
