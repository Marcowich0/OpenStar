# The Docker image

OpenStar ships as one `linux/amd64` image, built from the multi-stage `Dockerfile` at the
repository root. Publishing it to GHCR is CI's job (`ghcr.io/marcowich0/openstar`).

## What is in it

| Stage            | Base                                     | Produces                                                     |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `wasm`           | `rust:<rust-toolchain.toml>-slim-trixie` | the pitch detector as WASM (`crates/detector-wasm`)          |
| `frontend`       | `node:<.node-version>-trixie-slim`, pnpm | the Vite build (`web/dist`), WASM bundled with the worklet   |
| `server`         | `rust:<rust-toolchain.toml>-slim-trixie` | `openstar`, the release binary with `web/dist` embedded      |
| `toolchain`      | `rust:<rust-toolchain.toml>-slim-trixie` | nothing; the Mic bridge stage copies its Rust toolchain      |
| `bridge`         | `ubuntu:22.04`, pinned by digest         | `openstar-mic-bridge` (glibc 2.35+), and its release tarball |
| `bridge-release` | `scratch`                                | only the release tarball and its `.sha256`, for CI to export |
| `tools`          | `debian:trixie-slim`                     | `yt-dlp` and `deno`, checksums checked                       |
| `runtime`        | `debian:trixie-slim`, pinned by digest   | the image                                                    |

The runtime image holds:

- `/usr/local/bin/openstar`, the one server binary (frontend embedded; no Node);
- `ffmpeg` and `ffprobe` from Debian's `ffmpeg` package, CPU only (libx264);
- `/usr/local/bin/yt-dlp`, the official `yt-dlp_linux` standalone binary, and
  `/usr/local/bin/deno`, the official Deno release binary, as yt-dlp's JavaScript
  runtime. Both are pinned by the `YTDLP_VERSION` / `DENO_VERSION` build arguments, and
  the build fails when a download does not match `YTDLP_SHA256` / `DENO_SHA256`.
  Renovate bumps each version together with its checksum (`docs/renovate.md`);
- `ca-certificates`, for the TLS connection to USDB;
- `/usr/share/openstar/bridge/`, the Mic bridge files served under `/bridge/`: the
  `openstar-mic-bridge` binary of this very build, `install.sh` and the icon
  `openstar-mic-bridge.svg` (both from `crates/mic-bridge/install/`). The server works out
  `openstar-mic-bridge.sha256` itself.

## The Mic bridge

The `bridge` stage builds the Mic bridge on `ubuntu:22.04`, so it needs glibc 2.35 or newer
and runs on Ubuntu 22.04+, Debian 12+, Fedora and Arch. The build fails if the binary needs
a newer glibc symbol. It builds with the same Rust toolchain as the server, copied from the
`toolchain` stage, and with the same build identifier, so its `--version` equals the
server's. Graphics libraries are loaded at run time.

The same stage also packs the release tarball (`scripts/bridge-tarball.sh`, tested by
`just bridge-tarball-check`): `openstar-mic-bridge-<build id>-x86_64-linux.tar.gz`, one
folder holding the binary, `openstar-mic-bridge.desktop` and the icon, plus its `.sha256`.
`just bridge-release <dir> <build id>` exports the two files (the `bridge-release` stage).
To install from the tarball by hand, put the binary on `PATH`, the `.desktop` file in
`~/.local/share/applications/` and the icon in `~/.local/share/icons/hicolor/scalable/apps/`,
and write the server address into `~/.config/openstar-mic-bridge/server`.

## Running it

- **User:** `1000:1000` by default. Any other `user:` works, for example `user: "99:100"`
  on Unraid; there is no `PUID`/`PGID` entrypoint, and the user needs no entry in
  `/etc/passwd`. `HOME` is `/tmp`, so yt-dlp and Deno can keep their caches as any user.
- **Volumes:** `/songs` (the Library; mount it `:ro` for a read-only Library) and
  `/appdata` (database, cache, trash, backups). Both must be writable by the container's
  user, except `/songs` when it is meant to be read-only.
- **Port:** the server listens on `OPENSTAR_PORT`, `8080` by default.
- **Health:** the image's `HEALTHCHECK` runs `openstar healthcheck`, which asks
  `/healthz` on `OPENSTAR_PORT`. It checks every 2 s while the container starts, then
  every 30 s.
- Every other setting is an environment variable (`OPENSTAR_ADMIN_PIN` is required); the
  table is in `crates/server/src/config.rs`.

## Building and checking it locally

```sh
just image openstar:local edge-abc1234        # tag, build identifier
just image-smoke openstar:local edge-abc1234
```

The build identifier goes in as the `OPENSTAR_BUILD_ID` build argument (`X.Y.Z`,
`edge-<sha>` or `dev`). Instead, CI may pass `GITHUB_REF` and `GITHUB_SHA` as build
arguments, and the server derives the identifier from them. It appears in
`openstar --version`, the start-up logs and `GET /api/server-info`.

`just image-smoke` runs `scripts/image-smoke.sh` (the image's user, volumes, entrypoint
and `HEALTHCHECK`; the binary, the tools and the certificates; a container as `1000:1000`
and one as `99:100` reaching healthy, with the build identifier in their logs and
server-info, the pitch worklet and its WASM served from the container itself, and the
Mic bridge: the image's `/usr/share/openstar/bridge/` holds the binary, `install.sh` and
the icon; `/bridge/openstar-mic-bridge` matches its `.sha256`, its `--version` is the
server's build identifier, and it starts headless on this machine with `--wav` until the
server asks for its approval) and
`scripts/image-checksum.test.sh` (a wrong yt-dlp or Deno checksum fails
the build).

The image build needs a few GB of disk: the Rust and Node build images, and the release
build in a BuildKit cache mount.

## Publishing

`.github/workflows/ci.yml` builds, checks and publishes the image to
`ghcr.io/marcowich0/openstar`, on GitHub-hosted runners only. It never deploys, and there
is no Docker Hub mirror. Its jobs run in order, and a failing job stops the rest:

1. `ci`: `just ci`.
2. `image`: builds the image, runs `just image-smoke` on it, and scans it with Trivy, which
   fails on any HIGH or CRITICAL vulnerability that has a fix. This job has read-only
   permissions and never logs in to a registry.
3. `publish`: rebuilds the image from the `image` job's layer cache and pushes it with
   build provenance and an SBOM. It refuses to push if the rebuilt layers differ from
   the tested ones. This is the only job with `packages: write`.
4. `release`: for a `vX.Y.Z` tag only, creates a GitHub release with generated notes and
   two files, `openstar-mic-bridge-X.Y.Z-x86_64-linux.tar.gz` and its `.sha256`. This is
   the only job with `contents: write`.

The `image` job also exports the Mic bridge release files from the `bridge` stage it has
just built and checks that the tarball's binary is the image's. It keeps them for the
`release` job only for a `vX.Y.Z` tag: `:edge` and `:sha-…` builds publish the bridge
inside the image alone. No server binary and no distro package is ever published.

| Event                             | Build identifier | Pushes                               | Release |
| --------------------------------- | ---------------- | ------------------------------------ | ------- |
| pull request                      | `dev`            | nothing (steps 1 and 2 only)         | no      |
| push to `main`                    | `edge-<sha>`     | `:edge`, `:sha-<short>`              | no      |
| push of a `vX.Y.Z` tag            | `X.Y.Z`          | `:X.Y.Z`, `:X.Y`, `:X`, `:latest`    | yes     |
| weekly schedule (Monday, on main) | `edge-<sha>`     | `:edge` only, runtime stage uncached | no      |
| anything else (other branches)    | `dev`            | nothing                              | no      |

`scripts/ci-image-meta.sh` makes this decision, and `scripts/ci-image-meta.test.sh`
(`just ci-meta-check`, part of `just check`) tests it. The `publish` and `release` jobs
check the event and ref again in their `if:`. The weekly run rebuilds the `runtime`
stage without its layer cache, so Debian security fixes land even when no pin changed.

The package is created private on its first push. Make it public once, under the
package's settings on GitHub.
