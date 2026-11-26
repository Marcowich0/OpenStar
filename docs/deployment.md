# Running OpenStar

This guide is for the person who runs the server: on Unraid, or anywhere with Docker
Compose. OpenStar is one Docker image, `ghcr.io/marcowich0/openstar`, with two volumes
and a few environment variables. There is no config file and no settings screen.

The repository has two example compose files:

- [`compose.yaml`](../compose.yaml): OpenStar on its own, on plain HTTP. Good for trying
  it out on one computer.
- [`compose.caddy.yaml`](../compose.caddy.yaml): OpenStar behind Caddy with HTTPS. This
  is what you need for Phones to sing. It is an **example** for one DNS provider
  (Cloudflare); see [HTTPS for Phones](#https-for-phones).

## Local network only

**Never put OpenStar on a public address.** Run it on a trusted local network only: your
home network, or a guest network you control. Don't forward ports to it from the
internet, and don't give it a DNS record that points to it from outside.

OpenStar is built for guests in the same room. The 4-digit Join code is shown on the TV
and is not a password, and anyone who has joined can do everything except what the Admin
PIN guards. That is fine at a party, and unsafe on the internet.

## Quick start

1. Make the two folders and give them to the user the container runs as (`1000:1000` by
   default; `99:100` on Unraid, see [Unraid](#unraid)):

   ```sh
   mkdir -p songs appdata
   sudo chown 1000:1000 songs appdata
   ```

   If a folder doesn't exist, Docker creates it owned by `root`, and OpenStar stops at
   start with "the appdata folder /appdata cannot be written to".

2. Copy `compose.yaml` next to them and change `OPENSTAR_ADMIN_PIN` to a PIN of your
   own, 4 to 8 digits. OpenStar won't start with the placeholder.
3. Put your UltraStar songs in `songs/`, then run `docker compose up -d`.
4. Open `http://localhost:8080` on the server itself (or the computer that runs Docker)
   and enter the Admin PIN to make that browser the Stage.

`docker compose logs -f openstar` shows what OpenStar is doing. The container reports
healthy once `/healthz` answers.

### Without HTTPS: one screen, Local mics only

Browsers allow the microphone only on a secure page: HTTPS, or `http://localhost`. So a
Stage opened on `http://localhost:8080` can run a whole Party with **Local mics** (mics
plugged into the Stage computer) and no further setup. That is the quickest way to try
OpenStar.

Phones can't sing on such a Stage: they can't reach `localhost`, and over plain HTTP they
aren't allowed to use their microphone. The Stage shows a warning in place of the join QR
code until you set up HTTPS. The same goes for any Stage opened on a plain `http://`
address that isn't `localhost`.

## HTTPS for Phones

**OpenStar never handles HTTPS itself.** It serves plain HTTP on one port and has no TLS
settings. To let Phones use their microphone, put a reverse proxy in front of it that
serves HTTPS with a certificate Phones already trust, such as one from Let's Encrypt.

### Why not a self-signed certificate

A self-signed certificate does not work. Safari on iPhone and iPad refuses the secure
WebSocket (`wss://`) to a server with a self-signed certificate, even after you accept the
warning, so the Phone can never join. Installing your own certificate authority on every
guest's Phone is too much to ask. Use a real certificate for a domain you own.

You don't have to open anything to the internet for that: with the **DNS-01** challenge,
the certificate authority checks a DNS record, not your server. Your local DNS then points
the name at the server's local address, so Phones reach it inside your network.

### What the proxy must do

- **One route for everything.** Pages, media, the Mic bridge files under `/bridge` and
  every WebSocket share one address. Send the whole site to OpenStar's port; don't split
  paths.
- **Pass WebSocket upgrades** on that same route. Every browser and every Mic bridge holds
  a WebSocket.
- **Pass the client's address** in `X-Forwarded-For`. OpenStar logs it when someone
  enters a wrong Admin PIN. Also send `X-Forwarded-Proto`, so the Mic bridge install
  line gets the right `https://` address.

Caddy does all three with a plain `reverse_proxy`. With nginx, add the `Upgrade` and
`Connection` headers for WebSockets yourself.

### The Caddy example

`compose.caddy.yaml` runs OpenStar and a Caddy built with the
[`caddy-dns/cloudflare`](https://github.com/caddy-dns/cloudflare) module. Caddy gets a
certificate for your name through Cloudflare DNS-01, answers only devices on private
(local) addresses, and sends everything to OpenStar over the compose network. OpenStar's
own port is not published at all.

It is an **example**: it fits if your domain's DNS is at Cloudflare. Another DNS provider
needs its own Caddy module (see the
[list of caddy-dns modules](https://github.com/caddy-dns)) in the `xcaddy build` line and
its own settings on the `dns` line.

To use it:

1. Pick a name under a domain you own, for example `openstar.example.com`, and replace
   `openstar.example.com` in the file with it (two places: `OPENSTAR_PUBLIC_URL` and the
   Caddyfile).
2. In your local DNS (router, Pi-hole, AdGuard Home, ...), point that name at the
   server's local address. Don't create a public record for it at Cloudflare.
3. Create a Cloudflare API token with **Zone.Zone: Read** and **Zone.DNS: Edit** for that
   domain.
4. Make the folders and the two secret files next to the compose file:

   ```sh
   mkdir -p songs appdata caddy/data caddy/config secrets
   sudo chown 1000:1000 songs appdata
   printf '%s\n' 'your-pin' > secrets/openstar_admin_pin
   printf '%s\n' 'your-cloudflare-token' > secrets/cloudflare_api_token
   chmod 644 secrets/openstar_admin_pin   # OpenStar's user must be able to read it
   ```

   Keep the `secrets/` folder to yourself, and out of any git repository.

5. Start it with `docker compose -f compose.caddy.yaml up -d --build`. The first start
   builds Caddy and asks for the certificate, which can take a minute.
6. Open `https://openstar.example.com` (your own name) on the Stage computer.

To update Caddy, change its version in the `build` section (both `FROM` lines, and the
`image` name), then run `docker compose -f compose.caddy.yaml build --pull` and
`up -d`. Keep `caddy/data`: it holds the certificate.

If you use another proxy you already run (Nginx Proxy Manager, Traefik, SWAG, ...), give
OpenStar a host for one domain, with WebSockets on and a certificate it gets by DNS-01.

### The join address

The join QR code and the Mic bridge install line hold the **join address**. By default,
that's the address the Stage was opened on. Set `OPENSTAR_PUBLIC_URL` when Phones and Mic
bridges should use another one, for example when the Stage runs on
`http://localhost:8080` but Phones should use `https://openstar.example.com`. The Stage
warns when the join address is not HTTPS, and says to set `OPENSTAR_PUBLIC_URL` when it
is `localhost`.

## Settings

Every setting is an environment variable. An empty value counts as not set.

| Variable                                                  | Default                  | What it does                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENSTAR_ADMIN_PIN` or `OPENSTAR_ADMIN_PIN_FILE`         | none: **required**       | The Admin PIN, 4 to 8 digits. OpenStar refuses to start without it. It guards becoming the Stage, changing the Library's files and deleting kept data. There is no screen to change it: change the variable and restart, which ends every Unlock and forgets every remembered Stage browser. |
| `OPENSTAR_PORT`                                           | `8080`                   | The one plain-HTTP port OpenStar listens on, inside the container.                                                                                                                                                                                                                           |
| `OPENSTAR_PUBLIC_URL`                                     | not set                  | The join address for the QR code and the Mic bridge install line, such as `https://openstar.example.com`. Must start with `http://` or `https://`.                                                                                                                                           |
| `OPENSTAR_USDB_USERNAME` or `OPENSTAR_USDB_USERNAME_FILE` | not set                  | Your USDB login, for Downloads. Set both the username and the password, or neither. Without them the Downloads screen says how to set them.                                                                                                                                                  |
| `OPENSTAR_USDB_PASSWORD` or `OPENSTAR_USDB_PASSWORD_FILE` | not set                  | The USDB password that goes with the username.                                                                                                                                                                                                                                               |
| `OPENSTAR_YTDLP_AUTOUPDATE`                               | `true`                   | `true` or `false`. With `false`, OpenStar uses the yt-dlp in the image and never updates its own copy in `/appdata/bin`.                                                                                                                                                                     |
| `OPENSTAR_LOG`                                            | `info`                   | How much goes to the log, in `RUST_LOG` syntax: `warn`, `info`, `debug`, or for example `openstar=debug,warn`. Logs are plain text on stdout (`docker logs`).                                                                                                                                |
| `OPENSTAR_SONGS_DIR`                                      | `/songs`                 | Where the Library is. Leave it alone in Docker: mount your songs on `/songs` instead. It's for running OpenStar outside Docker.                                                                                                                                                              |
| `OPENSTAR_APPDATA_DIR`                                    | `/appdata`               | Where OpenStar keeps its own data. Leave it alone in Docker, as above.                                                                                                                                                                                                                       |
| `OPENSTAR_USDB_BASE_URL`                                  | `https://usdb.animux.de` | For OpenStar's own tests only, which point it at a fake USDB. Never set it.                                                                                                                                                                                                                  |

**`_FILE` variants.** For the three secrets, `<NAME>_FILE` names a file that holds the
value, so the value can live in a Docker secret instead of the compose file
(`compose.caddy.yaml` does this for the PIN). One line break at the end of the file is
ignored. Setting both a variable and its `_FILE` variant is an error, and OpenStar refuses
to start.

OpenStar checks the settings at start, and exits with a message naming the setting when
one is wrong. It never writes a secret to the log.

## Unraid

Run the container as Unraid's `nobody:users`, so files it writes in your shares get the
usual owner and permissions:

```yaml
services:
  openstar:
    user: "99:100"
```

There is no `PUID`/`PGID` variable: `user:` is the only way. The two folders must be
writable by `99:100` (shares under `/mnt/user` usually are). With the Compose Manager
plugin, paste the example compose file into a new stack, change the paths to your shares,
for example:

```yaml
volumes:
  - /mnt/user/karaoke/songs:/songs
  - /mnt/user/appdata/openstar:/appdata
```

and set the Admin PIN. Keep `/appdata` on a disk you back up (see
[Backups](#backups-are-your-job)).

## The Library: `/songs`

Mount your UltraStar Library on `/songs`. OpenStar reads every Song folder in it. It writes
there only for Downloads, saved Timing edits and deleting Songs (into its trash).

To protect a Library you don't want OpenStar to touch, mount it read-only with `:ro`:

```yaml
volumes:
  - ./songs:/songs:ro
```

Everything still plays. Downloads, Timing edits and deleting Songs are turned off, and the
Admin area says why. OpenStar does the same on its own when it can't write to `/songs`.

## OpenStar's data: `/appdata`

`/appdata` must be writable, or OpenStar refuses to start. It holds:

| Path                                                | What                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openstar.db`, `openstar.db-wal`, `openstar.db-shm` | The database (SQLite): Profiles, Score records, the Party and its Queue, Mic settings, the Library index and Download records. The three files belong together. |
| `cache/media/`                                      | Song audio and video converted into a format browsers play (see below).                                                                                         |
| `cache/pitch/`                                      | Pitch tracks for Auto-fit in the Timing editor.                                                                                                                 |
| `cache/usdb-covers/`                                | Song covers from USDB, for the Downloads screen.                                                                                                                |
| `bin/`                                              | OpenStar's own, self-updated copy of yt-dlp (about 35 MB).                                                                                                      |
| `trash/`                                            | Deleted Songs. Each is kept for 30 days and can be restored from the Admin area until then.                                                                     |
| `backups/`                                          | Snapshots of the database taken before an upgrade changes it (see [Upgrades](#upgrades-and-rolling-back)).                                                      |
| `tmp/`                                              | Downloads in progress. Emptied when OpenStar starts.                                                                                                            |
| `drafts/`                                           | Reserved for a later feature (writing new Songs). Nothing uses it yet; leave it alone.                                                                          |

Everything under `cache/` can be deleted while OpenStar is stopped: it is made again when
needed.

### How large the cache gets

Most of it is converted video. OpenStar converts only the files a browser can't play as
they are. Files that play directly need no cache at all:

- audio: MP3, AAC (`.m4a`), Ogg Vorbis, Opus, FLAC or WAV;
- video: H.264, VP8, VP9 or AV1 in MP4, MOV, WebM or MKV. Songs you download through
  OpenStar are already H.264 MP4.

Everything else, such as `.avi`, `.divx`, `.mpg` or `.wmv` videos (common in older UltraStar
Libraries) and WMA audio, is converted once to H.264/AAC MP4 at up to 1080p:

- a converted video takes roughly **50 to 300 MB** per Song, about as much as the
  original;
- a converted audio file takes about **1.5 MB per minute** (about 6 MB per Song);
- a Pitch track takes about **300 KB** per Song, made only when you use Auto-fit.

So plan for about as much free space in `/appdata` as the videos in your Library that
aren't H.264, VP8, VP9 or AV1. A Library whose videos already play directly keeps the cache
small: a few MB for audio conversions and covers. Conversions of Songs that leave the
Library or change are removed at the next scan. Deleted Songs also take space in `trash/`
for 30 days.

## Image tags

The image is `ghcr.io/marcowich0/openstar`, `linux/amd64` only.

| Tag                             | What it is                                             | Use it for                                                    |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `:X.Y.Z` (for example `:1.2.3`) | One release, never changed.                            | Choosing exactly when you upgrade, and rolling back.          |
| `:X.Y` (for example `:1.2`)     | The newest `X.Y.Z` release.                            | Getting fixes for that version only.                          |
| `:X` (for example `:1`)         | The newest `X.Y.Z` release with that major version.    | Getting every release that doesn't break anything on purpose. |
| `:latest`                       | The newest release.                                    | The simplest choice. The examples use it.                     |
| `:edge`                         | The newest build from `main`, rebuilt at least weekly. | Trying unreleased work. Not tested by hand like a release.    |
| `:sha-<short>`                  | One build from `main`.                                 | Pinning a single `:edge` build.                               |

Every tag includes the Mic bridge of exactly the same build, served under `/bridge`.

## Upgrades and rolling back

To upgrade, pull the new image and restart: `docker compose pull && docker compose up -d`.
OpenStar keeps the Party, its Line-up and Queue across a restart; only a Song being sung at
that moment is lost. Phones and Mic bridges reconnect by themselves.

When a new version needs to change the database, it first writes a snapshot of it to
`/appdata/backups/openstar-<version>.db`, named after the version that last wrote the
database (for example `openstar-1.2.3.db`, or `openstar-edge-abc1234.db` from an `:edge`
build). It keeps the three newest snapshots.

An older version refuses to start on a database a newer one has changed, and its log names
the snapshot to restore. To roll back an upgrade:

1. Stop OpenStar: `docker compose down`.
2. Keep a copy of the current database, in case you want to go forward again: copy
   `openstar.db` (and `-wal`, `-shm` if present) somewhere safe.
3. Copy the snapshot over the database, and delete the two files that belong to the newer
   one:

   ```sh
   cp appdata/backups/openstar-1.2.3.db appdata/openstar.db
   rm -f appdata/openstar.db-wal appdata/openstar.db-shm
   ```

4. Set the image back to the version in the snapshot's name (for example
   `ghcr.io/marcowich0/openstar:1.2.3`) and start: `docker compose up -d`.

Anything recorded after the upgrade, such as new Score records, is not in the snapshot.
This is why pinning `:X.Y.Z` helps: you always know which version to go back to.

## Backups are your job

OpenStar does not back up `/appdata`. The snapshots in `backups/` only cover upgrades, and
sit on the same disk. Back up `/appdata` as part of your server's usual backups (on Unraid,
for example with the Appdata Backup plugin). Stop the container first, or copy
`openstar.db` together with `openstar.db-wal` and `openstar.db-shm`, so the copy is
complete. You can leave `cache/` out. Back up your Library in `/songs` as well: it is your
own files.

To restore, stop OpenStar, put the backed-up `/appdata` back, and start it with the same
image version or a newer one.
