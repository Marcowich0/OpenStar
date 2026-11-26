# Keeping the pins current: Renovate

Every version OpenStar depends on is pinned, and [Renovate](https://docs.renovatebot.com/)
bumps every pin with a pull request. The configuration is `renovate.json` at the
repository root. Dependabot version updates are not used: Dependabot cannot bump a
version `ARG` in the Dockerfile or the checksum under it, and there is no
`.github/dependabot.yml` (`just pins-check` fails if one appears).

## What Renovate bumps

| Pin                | Where                                                                                                                                                                                    | Group, schedule             | Merged                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| Rust toolchain     | `rust-toolchain.toml`, `rust-version` in `Cargo.toml`, `rust:<v>-slim-trixie` in the Dockerfile (`wasm`, `server` and `toolchain`, which the Mic bridge stage copies its toolchain from) | Rust toolchain, weekly      | after review                   |
| Crates             | `=` pins in `Cargo.toml` (and `Cargo.lock`), `cargo-deny@…` in `ci.yml`                                                                                                                  | crates, weekly              | after review                   |
| npm packages       | `web/package.json`, `e2e/package.json` (and their lockfiles)                                                                                                                             | npm packages, weekly        | after review                   |
| Playwright         | `@playwright/test` in `e2e/package.json` and the image tag and digest in `scripts/e2e.sh`, together                                                                                      | Playwright, weekly          | after review                   |
| Node               | `.node-version` and `node:<v>-trixie-slim` in the Dockerfile, together                                                                                                                   | Node, weekly                | after review                   |
| pnpm               | `packageManager` in both `package.json` files and `PNPM_VERSION` in the Dockerfile, together                                                                                             | pnpm, weekly                | after review                   |
| yt-dlp             | `YTDLP_VERSION` and `YTDLP_SHA256` in the Dockerfile                                                                                                                                     | own pull request, **daily** | patch and minor once CI passes |
| Deno               | `DENO_VERSION` and `DENO_SHA256` in the Dockerfile                                                                                                                                       | own pull request, weekly    | patch and minor once CI passes |
| Trivy              | `TRIVY_VERSION` and `TRIVY_SHA256` in `ci.yml`                                                                                                                                           | own pull request, weekly    | patch and minor once CI passes |
| Base-image digests | `debian:trixie-slim`, the Mic bridge's `ubuntu:22.04`, the BuildKit `# syntax=` image, and a new digest of an unchanged rust, node or Playwright tag                                     | base-image digests, weekly  | once CI passes                 |
| Action SHAs        | every `uses:` in `.github/workflows/`, and `just-version` of setup-just                                                                                                                  | GitHub Actions, weekly      | patch and minor once CI passes |
| Lockfiles          | `Cargo.lock`, `web/pnpm-lock.yaml`, `e2e/pnpm-lock.yaml` (lockfile maintenance)                                                                                                          | weekly                      | after review                   |

Rules that hold across the table:

- **Every major version waits for review**, whatever its group. yt-dlp's versions are
  dates (`YYYY.MM.DD`), so its first release of a new year counts as major.
- **Weekly** means Monday, 00:00–06:00 UTC; yt-dlp is checked every day in the same hours.
- **npm bumps wait two days after the release**, because pnpm refuses packages published
  less than a day ago and the lockfile update would fail.
- **`ubuntu:22.04` gets digest bumps only.** A newer Ubuntu would raise the Mic bridge's
  glibc floor (2.35), which was decided. Runner labels (`runs-on: ubuntu-24.04`) are not
  bumped either; change them by hand.
- **"Once CI passes"**: Renovate merges such a pull request itself (`platformAutomerge`
  is off), and only when every check on its last commit has passed. CI on a pull request
  runs `just ci`, builds the image, smoke-tests it and scans it, so a yt-dlp or Deno bump
  is only merged after the image built with its new checksum.

## Checksums move with their version

yt-dlp, Deno and Trivy are downloaded as release files whose checksum the build checks.
Their `# renovate:` comment names the `github-release-attachments` datasource, and their
`*_SHA256` line sits directly below the `*_VERSION` line (comment lines may come between).
For a bump, Renovate finds the current checksum in the current release's checksum file
(`SHA2-256SUMS`, `deno-x86_64-unknown-linux-gnu.zip.sha256sum`,
`trivy_<v>_checksums.txt`), reads the same file name's line in the new release, and writes
both the new version and the new checksum. So the pull request builds with no hand edit.

The datasource fetches the release by the pinned value, so the value must be the release's
git tag exactly: that is why `TRIVY_VERSION` is `v0.76.2` and the workflow strips the `v`
for the file name.

## Adding a pin

`just pins-check` (`scripts/check-pins.sh`, part of `just check`) fails when a new pin is
one Renovate would miss:

- a `FROM` without `@sha256:` (Renovate then pins it, but the check asks for it up front);
- a `uses:` without a full commit SHA and a `# vX.Y.Z` comment;
- a `*_VERSION` build argument or workflow variable without a
  `# renovate: datasource=<datasource> depName=<name>` comment on the line above;
- a `*_SHA256` that is not under a `*_VERSION` whose datasource is
  `github-release-attachments`;
- the Playwright image's version differing from `@playwright/test`.

A new stage that needs Rust on another base copies `/usr/local/rustup` and
`/usr/local/cargo` from the Dockerfile's `toolchain` stage, as the Mic bridge's
`ubuntu:22.04` stage does. So it builds with the very toolchain of the other Rust stages,
and the Rust toolchain group bumps it with no pin of its own.

## Switching it on (owner, once)

Nothing runs until these are done by hand:

1. **Merge `renovate.json` to `main`.** Renovate reads its configuration from the default
   branch. Because the file already exists, it skips its onboarding pull request.
2. **Install the Renovate GitHub app** (Mend's hosted Renovate,
   <https://github.com/apps/renovate>) on the account, and give it access to
   `Marcowich0/OpenStar` only ("Only select repositories").
3. **Let Renovate merge.** Renovate merges the automatic pull requests itself, so the
   repository's "Allow auto-merge" setting is not needed. If `main` has a branch
   protection rule or ruleset that requires approving reviews, Renovate cannot merge:
   either require only status checks (recommended: require the `ci` and `image` checks,
   so no pull request merges red), or add the Renovate app to the rule's bypass list.
4. **Dependabot:** leave "Dependabot version updates" off (there is no
   `dependabot.yml`). Keep "Dependabot alerts" on: Renovate reads them and opens security
   pull requests outside the schedule.
5. **Watch the first run.** Renovate opens a "Dependency Dashboard" issue that lists every
   dependency it found and every pending update. Check that it lists everything in the
   table above; a pin it does not list is a pin it cannot see.
