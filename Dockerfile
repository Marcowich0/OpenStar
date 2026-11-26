# syntax=docker/dockerfile:1
# check=skip=FromPlatformFlagConstDisallowed
#
# Every stage is pinned to linux/amd64 on purpose: v1 ships amd64 only, and
# the yt-dlp and Deno downloads are x86-64 binaries.
#
# The OpenStar image (docs/docker-image.md): one server binary with the
# frontend embedded, plus ffmpeg, ffprobe, yt-dlp and Deno, on Debian trixie.
# Build it with `just image`; `just image-smoke` checks the result.
#
# Every version is pinned here; Renovate bumps them (the `# renovate:` lines).
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
# Tools: yt-dlp and Deno, downloaded at pinned versions. The build fails when
# a download does not match its checksum.
FROM --platform=linux/amd64 debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS tools
# renovate: datasource=github-releases depName=yt-dlp/yt-dlp
ARG YTDLP_VERSION=2026.11.23
# The `yt-dlp_linux` line of the release's SHA2-256SUMS.
ARG YTDLP_SHA256=249ddb058234276bc449b9cd9492aad9f133bda5923c61a9e39983ae114ef17d
# renovate: datasource=github-releases depName=denoland/deno
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
FROM --platform=linux/amd64 debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /out/yt-dlp /out/deno /usr/local/bin/
COPY --from=server /out/openstar /usr/local/bin/openstar
# The Mic bridge files served under /bridge/ (#208 puts them here), and the
# two volumes, owned by the default user so fresh named volumes are writable.
RUN mkdir -p /usr/share/openstar/bridge /songs /appdata \
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
