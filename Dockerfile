# syntax=docker/dockerfile:1
# check=skip=FromPlatformFlagConstDisallowed
#
# Every stage is pinned to linux/amd64 on purpose: v1 ships amd64 only, and
# the yt-dlp and Deno downloads are x86-64 binaries.
#
# The OpenStar image (docs/docker-image.md): one server binary with the
# frontend embedded, plus ffmpeg, ffprobe, yt-dlp, Deno and the matching Mic
# bridge, on Debian trixie.
# Build it with `just image`; `just image-smoke` checks the result.
#
# Every version is pinned here; Renovate bumps them (renovate.json, the
# `# renovate:` lines). For yt-dlp and Deno the datasource is
# github-release-attachments, so a bump also carries the new checksum: keep
# each `*_SHA256` right below its `*_VERSION` (scripts/check-pins.sh).
# The base images are pinned by digest as well as by tag.

# The build identifier (crates/server/src/build_id.rs): `X.Y.Z`, `edge-<sha>`
# or `dev`. CI passes OPENSTAR_BUILD_ID, or GITHUB_REF and GITHUB_SHA.
ARG OPENSTAR_BUILD_ID=""
ARG GITHUB_REF=""
ARG GITHUB_SHA=""

# ---------------------------------------------------------------------------
# WASM: the pitch detector (crates/detector-wasm) for the pitch-detection
# AudioWorklet, built for wasm32-unknown-unknown with the same pinned
# toolchain image as the server stage, before the frontend stage's Vite build
# bundles it. The target is the one rust-toolchain.toml names.
FROM --platform=linux/amd64 rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2 AS wasm
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN --mount=type=cache,id=openstar-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=openstar-cargo-wasm-target,target=/src/target \
    cargo build --release --locked --target wasm32-unknown-unknown -p openstar-detector-wasm \
    && install -D -m 0644 target/wasm32-unknown-unknown/release/openstar_detector_wasm.wasm /out/openstar_detector.wasm

# ---------------------------------------------------------------------------
# Frontend: the Vite build, embedded into the server binary below. It bundles
# the WASM stage's module (web/wasm/) with the pitch worklet.
FROM --platform=linux/amd64 node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS frontend
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.23.0
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=openstar-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/ ./
COPY --from=wasm /out/openstar_detector.wasm wasm/openstar_detector.wasm
RUN pnpm build

# ---------------------------------------------------------------------------
# Server: the release binary, with web/dist embedded by rust-embed.
# The slim variant of rust:<version>-trixie: the same toolchain and Debian
# trixie (so the binary links against the runtime stage's glibc), with gcc for
# the C parts (aws-lc-sys, SQLite), at a third of the disk.
FROM --platform=linux/amd64 rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2 AS server
ARG OPENSTAR_BUILD_ID
ARG GITHUB_REF
ARG GITHUB_SHA
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY --from=frontend /src/web/dist web/dist
RUN --mount=type=cache,id=openstar-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=openstar-cargo-target,target=/src/target \
    OPENSTAR_BUILD_ID="${OPENSTAR_BUILD_ID}" GITHUB_REF="${GITHUB_REF}" GITHUB_SHA="${GITHUB_SHA}" \
    cargo build --release --locked -p openstar \
    && install -D -m 0755 target/release/openstar /out/openstar

# ---------------------------------------------------------------------------
# The pinned Rust toolchain, as a stage of its own: the Mic bridge stage
# copies it from here, so every Rust stage builds with the very same
# toolchain (the one rust-toolchain.toml names) and Renovate bumps it with
# the other rust:<version> lines.
FROM --platform=linux/amd64 rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2 AS toolchain

# ---------------------------------------------------------------------------
# Mic bridge: built on Ubuntu 22.04, so the binary needs glibc 2.35 or newer
# and runs on any current desktop (Ubuntu 22.04+, Debian 12+, Fedora, Arch).
# Graphics libraries are loaded at run time (crates/mic-bridge/tests/window.rs
# checks the binary's NEEDED list). The same build identifier as the server.
# Its output is both what the runtime image serves under /bridge/ and the
# release tarball (stage `bridge-release`), so the two are the same binary.
FROM --platform=linux/amd64 ubuntu:22.04@sha256:b000e69a50ff940390233025e7a337fb8469b509e2334fa4d018ac30f3e18cdb AS bridge
ARG OPENSTAR_BUILD_ID
ARG GITHUB_REF
ARG GITHUB_SHA
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY --from=toolchain /usr/local/rustup /usr/local/rustup
COPY --from=toolchain /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY scripts/bridge-tarball.sh scripts/
RUN --mount=type=cache,id=openstar-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=openstar-cargo-bridge-target,target=/src/target \
    OPENSTAR_BUILD_ID="${OPENSTAR_BUILD_ID}" GITHUB_REF="${GITHUB_REF}" GITHUB_SHA="${GITHUB_SHA}" \
    cargo build --release --locked -p openstar-mic-bridge --bin openstar-mic-bridge \
    && install -D -m 0755 target/release/openstar-mic-bridge /out/bridge/openstar-mic-bridge
# The glibc floor: no symbol newer than GLIBC_2.35.
RUN newest="$(objdump -T /out/bridge/openstar-mic-bridge | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sed 's/GLIBC_//' | sort -uV | tail -n 1)" \
    && echo "the Mic bridge needs glibc ${newest}" \
    && [ "$(printf '%s\n2.35\n' "$newest" | sort -V | tail -n 1)" = 2.35 ]
RUN install -m 0644 crates/mic-bridge/install/install.sh crates/mic-bridge/install/openstar-mic-bridge.svg /out/bridge/ \
    && scripts/bridge-tarball.sh /out/bridge/openstar-mic-bridge crates/mic-bridge/install /out/release

# The release files alone: `openstar-mic-bridge-<build id>-x86_64-linux.tar.gz`
# and its .sha256. CI exports this stage for a vX.Y.Z release
# (`docker buildx build --target bridge-release --output type=local,...`).
FROM scratch AS bridge-release
COPY --from=bridge /out/release/ /

# ---------------------------------------------------------------------------
# Tools: yt-dlp and Deno, downloaded at pinned versions. The build fails when
# a download does not match its checksum.
FROM --platform=linux/amd64 debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS tools
# renovate: datasource=github-release-attachments depName=yt-dlp/yt-dlp
ARG YTDLP_VERSION=2026.11.23
# The `yt-dlp_linux` line of the release's SHA2-256SUMS.
ARG YTDLP_SHA256=249ddb058234276bc449b9cd9492aad9f133bda5923c61a9e39983ae114ef17d
# renovate: datasource=github-release-attachments depName=denoland/deno
ARG DENO_VERSION=v2.9.8
# The release's deno-x86_64-unknown-linux-gnu.zip.sha256sum.
ARG DENO_SHA256=e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /download
RUN curl -fsSL -o yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
    && echo "${YTDLP_SHA256}  yt-dlp" | sha256sum --check --strict \
    && install -D -m 0755 yt-dlp /out/yt-dlp
RUN curl -fsSL -o deno.zip \
        "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
    && echo "${DENO_SHA256}  deno.zip" | sha256sum --check --strict \
    && unzip -q deno.zip deno \
    && install -D -m 0755 deno /out/deno

# ---------------------------------------------------------------------------
# Runtime: Debian with ffmpeg (CPU only) and the system CA certificates (the
# USDB client verifies TLS against them). No Node, no build tools.
# `apt-get upgrade` brings in Debian's security fixes for packages already in
# the pinned base image: without it a fix only arrives when the base digest is
# bumped, and the weekly uncached rebuild of this stage would change nothing.
FROM --platform=linux/amd64 debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS runtime
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /out/yt-dlp /out/deno /usr/local/bin/
COPY --from=server /out/openstar /usr/local/bin/openstar
# The Mic bridge files the server serves under /bridge/: the bridge of this
# build, the install script and the icon.
COPY --from=bridge /out/bridge/ /usr/share/openstar/bridge/
# The two volumes, owned by the default user so fresh named volumes are writable.
RUN mkdir -p /songs /appdata \
    && chown 1000:1000 /songs /appdata
# Any `user:` works (for example 99:100 on Unraid): no user needs to exist in
# /etc/passwd, and HOME points at a folder every user can write, for the
# caches of yt-dlp and Deno.
ENV HOME=/tmp \
    OPENSTAR_PORT=8080 \
    OPENSTAR_SONGS_DIR=/songs \
    OPENSTAR_APPDATA_DIR=/appdata
USER 1000:1000
VOLUME ["/songs", "/appdata"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["openstar", "healthcheck"]
ENTRYPOINT ["openstar"]
