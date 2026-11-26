# OpenStar's commands. CI runs only `just ci`; run `just check` before you push.

set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

# Every fast check: Rust, dependency licences and advisories, TypeScript,
# Prettier, the generated-types drift check and the fixture rules.
check: rust-check deny-check web-check e2e-check format-check drift-check fixtures-check

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

# The only command that writes the painter screenshot baselines
# (e2e/tests/__screenshots__/): it deletes them and takes them again in the
# same pinned Playwright image as `just e2e`. Commit the changed images; the
# PR shows them.
update-screenshots: build harness-build e2e-install screenshot-page
    OPENSTAR_E2E_UPDATE_SCREENSHOTS=1 scripts/e2e.sh tests/painter.spec.ts

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
# and that it starts as 1000:1000 and as 99:100. Then check that a wrong
# yt-dlp or Deno checksum fails the build.
image-smoke tag="openstar:local" build_id="dev":
    scripts/image-smoke.sh {{ tag }} {{ build_id }}
    scripts/image-checksum.test.sh

# Run the server on OPENSTAR_PORT (default 8080) with ./.appdata and ./.songs.
run: web-build
    mkdir -p .appdata .songs
    OPENSTAR_APPDATA_DIR="${OPENSTAR_APPDATA_DIR:-$PWD/.appdata}" OPENSTAR_SONGS_DIR="${OPENSTAR_SONGS_DIR:-$PWD/.songs}" cargo run -p openstar
