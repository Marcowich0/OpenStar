# The Docker image

OpenStar ships as one `linux/amd64` image, built from the multi-stage `Dockerfile` at the
repository root. Publishing it to GHCR is CI's job (`ghcr.io/marcowich0/openstar`).

## What is in it

| Stage      | Base                                     | Produces                                                |
| ---------- | ---------------------------------------- | ------------------------------------------------------- |
| `frontend` | `node:<.node-version>-trixie-slim`, pnpm | the Vite build (`web/dist`)                             |
| `server`   | `rust:<rust-toolchain.toml>-slim-trixie` | `openstar`, the release binary with `web/dist` embedded |
| `tools`    | `debian:trixie-slim`                     | `yt-dlp` and `deno`, checksums checked                  |
| `runtime`  | `debian:trixie-slim`, pinned by digest   | the image                                               |

The runtime image holds:

- `/usr/local/bin/openstar`, the one server binary (frontend embedded; no Node);
- `ffmpeg` and `ffprobe` from Debian's `ffmpeg` package, CPU only (libx264);
- `/usr/local/bin/yt-dlp`, the official `yt-dlp_linux` standalone binary, and
  `/usr/local/bin/deno`, the official Deno release binary, as yt-dlp's JavaScript
  runtime. Both are pinned by the `YTDLP_VERSION` / `DENO_VERSION` build arguments, and
  the build fails when a download does not match `YTDLP_SHA256` / `DENO_SHA256`;
- `ca-certificates`, for the TLS connection to USDB;
- `/usr/share/openstar/bridge/`, the Mic bridge files served under `/bridge/`.

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
server-info) and `scripts/image-checksum.test.sh` (a wrong yt-dlp or Deno checksum fails
the build).

The image build needs a few GB of disk: the Rust and Node build images, and the release
build in a BuildKit cache mount.
