# OpenStar's commands. CI runs only `just ci`; run `just check` before you push.

set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

# Every fast check: Rust, TypeScript and the generated-types drift check.
check: rust-check web-check drift-check

# What CI runs. The end-to-end tests (`just e2e`) join it once they exist.
ci: check

# Format, lint and test the whole Cargo workspace.
rust-check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --locked

# Lint, type-check and test the frontend.
web-check: web-install
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

# Build the frontend into web/dist.
web-build: web-install
    pnpm --dir web build

# Build the release binary with the frontend embedded (target/release/openstar).
build: web-build
    cargo build --release --locked -p openstar

# Run the server on OPENSTAR_PORT (default 8080) with ./.appdata and ./.songs.
run: web-build
    mkdir -p .appdata .songs
    OPENSTAR_APPDATA_DIR="${OPENSTAR_APPDATA_DIR:-$PWD/.appdata}" OPENSTAR_SONGS_DIR="${OPENSTAR_SONGS_DIR:-$PWD/.songs}" cargo run -p openstar
