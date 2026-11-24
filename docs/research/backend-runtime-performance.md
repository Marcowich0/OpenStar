# Backend runtime performance candidates

Research for issue #8. Sources were read on 2026-11-24. This file reports what
the sources say per kind of work. It does not pick a runtime; that is a later
ticket.

Candidates: **Rust** (tokio, axum, tower-http, rusqlite), **Go** (standard
library `net/http`, a WebSocket package, an SQLite driver) and **Bun/TypeScript**
(`Bun.serve`, `bun:sqlite`). Others are covered briefly at the end.

Claims marked **unverified** have no primary source behind them. Statements
marked **inference** are my reading of the sources, not something a source says.

## Summary

| Kind of work | What the sources show | Does it matter at home-server scale? |
|---|---|---|
| Library scan and parse | No published benchmark covers this workload. CPU-bound toy benchmarks put Rust ahead of Go, and Go ahead of Node.js. | Probably little: the scan is mostly file-system reads (inference). Needs a measurement. |
| Media files with range requests | All three handle `Range` out of the box. Go and Bun document `sendfile`; tower-http reads 64 KB chunks through a thread pool. | No. A handful of video streams is far below what any of them serves. |
| Real-time message relay | Rust, Bun and the fastest Go setups all exceed 2 million HTTP requests per second in TechEmpower. Worst-case latency was lowest for Rust. | Throughput: no. Latency tail: the only place a difference could be felt, and it is not measured for WebSockets. |
| yt-dlp and ffmpeg jobs | The work runs in child processes. All three spawn and stream them. | No. But yt-dlp's own needs shape the image for every candidate. |
| Embedded database | All three use SQLite. Rust and Bun link the C library directly. Go must choose between cgo and slower pure-Go drivers. | No, for a few thousand rows of Songs and scores. |
| Memory | Small Rust and Go programs use 3 to 5 MB; Node.js uses 64 to 111 MB in the same tests. Bun is not measured. | Minor on a server with gigabytes of RAM. |
| Image size | The backend adds from a few MB (static Rust or Go binary) to 57 to 104 MB compressed (Bun base images). ffmpeg, yt-dlp and a JS runtime for yt-dlp add more than that. | Minor: the image is dominated by the tools, not the backend. |

## General HTTP throughput and latency (TechEmpower Round 23)

TechEmpower Framework Benchmarks is the largest reproducible comparison. Two
facts about it matter before reading numbers:

- Round 23 (run from 2025-01-30, published 2025-03-17) is the last numbered
  round. The repository was archived on GitHub, with its last push on
  2026-03-24.[^tfb-repo] The numbers are therefore about two years old and
  predate current versions of all three runtimes.
- The test machines were ProLiant DL360 Gen10 Plus servers with a 56-core Intel
  Xeon Gold 6330, 64 GB of memory and 40 Gbps Ethernet.[^tfb-r23] OpenStar's
  host has far fewer cores, so absolute numbers do not transfer.

I extracted the JSON serialisation test (no database, the closest to OpenStar's
small-message work) from the published raw results.[^tfb-data] Each row is the
framework's best concurrency level, over a 15-second run:

| Framework | Language | Requests/s | Avg latency | Max latency |
|---|---|---|---|---|
| hyper | Rust | 2,885,610 | 0.17 ms | 2.04 ms |
| axum | Rust | 2,709,795 | 0.18 ms | 5.79 ms |
| fasthttp-prefork | Go | 2,545,984 | not extracted | not extracted |
| aspnetcore | C# | 2,546,481 | 0.19 ms | 19.81 ms |
| bun (`Bun.serve`) | TypeScript | 2,097,129 | 0.31 ms | 10.83 ms |
| elysia (on Bun) | TypeScript | 1,837,294 | 0.41 ms | 14.24 ms |
| deno | TypeScript | 1,806,460 | 0.28 ms | 11.74 ms |
| nodejs | JavaScript | 1,147,305 | 0.45 ms | 31.95 ms |
| echo | Go | 855,437 | 0.37 ms | 8.70 ms |
| fasthttp | Go | 582,069 | 0.26 ms | 6.40 ms |
| gin | Go | 498,192 | 1.39 ms | 30.13 ms |
| go (`net/http`) | Go | 388,485 | 1.58 ms | 44.71 ms |
| express | JavaScript | 224,163 | 2.47 ms | 35.36 ms |

Notes on reading this table:

- Go's standard `net/http` entry is 7 times slower than Go's prefork entries on
  the same machine. Prefork runs one process per core. **Inference:** the
  standard Go entries scale poorly on this 56-core machine, and the gap is
  unlikely to be the same on a small home server. The table does not show how Go
  behaves on 4 to 8 cores.
- Actix (Rust) is missing because it failed to build in this round.[^tfb-actix]
- The latency columns come from the load generator's summary. They are a mean
  and a maximum, not percentiles. TechEmpower does not publish p99 for this run
  in the data I read.
- TechEmpower publishes no memory figures.

**At home-server scale:** every candidate, including the slowest row, handles
several orders of magnitude more requests than a handful of Phones and one
Stage will send. Throughput does not separate the candidates for OpenStar.

## 1. Library scan and parse

The work: walk a directory tree with tens of thousands of `.txt` files, read
each, decode it and parse it.

What the sources say:

- **Go.** `filepath.WalkDir` avoids calling `os.Lstat` on every entry, which the
  older `filepath.Walk` does. It walks in lexical order and reads each whole
  directory into memory first.[^go-filepath]
- **Rust.** The `walkdir` crate describes itself as "an efficient and cross
  platform implementation of recursive directory traversal".[^walkdir] Under
  tokio, file operations run as ordinary blocking calls on a thread pool, and
  the tokio documentation warns that this "has serious performance
  consequences" unless operations are batched. It recommends using `std::fs`
  inside one `spawn_blocking` call for such work.[^tokio-fs]
- **Bun.** `Bun.Glob` offers `scan` and `scanSync` over a directory tree. The
  documentation calls it a "fast native implementation" without
  figures.[^bun-glob]

Published numbers for the CPU side only: in the Benchmarks Game (quad-core Intel
i5-3330, Ubuntu 24.04)[^bg-how], the fastest Rust programs beat the fastest Go
programs in every task I read, by 1.5 to 4 times in elapsed time (for example
n-body 2.19 s against 6.39 s; mandelbrot 0.95 s against 3.77 s).[^bg-rust-go] Go
and Node.js are close in the same tasks (fannkuch-redux 8.36 s against 11.07 s;
spectral-norm 1.43 s against 1.60 s).[^bg-go-node] Bun is not in the Benchmarks
Game.

Gaps:

- **Unverified:** no primary source benchmarks directory walking plus text
  parsing across these three runtimes. The Benchmarks Game tasks are numeric
  kernels, not text parsing.
- **Unverified:** how each handles the legacy encodings found in UltraStar
  files. I did not check the encoding libraries.

**At home-server scale (inference):** parsing a `.txt` of a few kilobytes costs
microseconds of CPU in any of the three. The scan time is set by how fast the
storage returns tens of thousands of small files, which is the same for all
runtimes. The runtimes differ in how easily they read files in parallel: Go and
Rust use all cores; Bun's JavaScript runs on one thread unless the work is split
across workers. This is the kind of work where a measurement on the real Library
would tell more than any published benchmark.

## 2. Media files with range requests

The work: serve video and audio files of tens to hundreds of megabytes to one
Stage browser, which seeks with `Range` requests.

- **Go.** `http.ServeContent` (and `ServeFile`, built on it) "handles Range
  requests properly, sets the MIME type, and handles If-Match,
  If-Unmodified-Since, If-None-Match, If-Modified-Since, and If-Range
  requests".[^go-http] The server's response writer has a `ReadFrom` method
  written "to optimize copying from an `*os.File` regular file to a
  `*net.TCPConn` with sendfile".[^go-sendfile]
- **Bun.** Returning `new Response(Bun.file(path))` gives range support with
  `Accept-Ranges` and `Content-Range`, plus `Last-Modified`, a weak `ETag` and
  `304` handling. `If-Range` only works with the `Last-Modified` date because
  the ETag is weak.[^bun-routing] Bun "automatically uses the sendfile(2) system
  call when possible".[^bun-routing] The file I/O table limits that to plain
  HTTP: socket output uses `sendfile` "if http, not https".[^bun-fileio]
- **Rust.** tower-http's `ServeDir` and `ServeFile` handle range requests
  (single ranges; multi-range requests can be ignored by option) and read the
  file in chunks, 64 KB by default.[^tower-servedir] They read through tokio's
  file API, which uses the blocking thread pool.[^tokio-fs] **Unverified:**
  I found no statement that tower-http uses `sendfile`; the chunked read
  suggests it copies through user space.

One constraint applies to all three: browsers only expose the microphone in a
secure context (HTTPS).[^mdn-gum] If the backend terminates TLS itself,
`sendfile` cannot be used (Bun says so explicitly; for Go and Rust this is
inference from how kernel `sendfile` works). If a reverse proxy terminates TLS,
the proxy does the final copy either way.

**At home-server scale:** a 1080p video is a few megabits per second. Copying
that through user space costs a negligible share of one core. The difference
between `sendfile` and chunked reads is real at thousands of streams and
invisible at one to five. What matters here is correctness of range handling,
which all three provide.

## 3. Real-time message relay

The work: relay many small messages between Phones and the Stage over
WebSockets, with low and steady delay.

Libraries and what they claim:

- **Bun.** WebSockets are built into `Bun.serve`, with a native publish and
  subscribe API by topic. Bun's documentation reports about 700,000 messages
  per second against about 100,000 for Node.js with `ws`, for a chat room with
  16 clients on Linux x64. That test used Bun v0.2.1 and Node v18.10.0, so it is
  several years old, and it is the vendor's own benchmark. The implementation
  is built on uWebSockets.[^bun-ws]
- **Go.** There is no WebSocket server in the standard library.
  `golang.org/x/net/websocket` is deprecated.[^coder-ws] The two usual choices
  are `gorilla/websocket`, which states it is complete, tested, has a stable API
  and passes the Autobahn test suite[^gorilla-ws], and `coder/websocket`, which
  lists zero dependencies, zero-allocation reads and writes, concurrent writes
  and Autobahn compliance.[^coder-ws]
- **Rust.** axum's WebSocket support is built on `tokio-tungstenite`. A socket
  can be split into a sender and a receiver to read and write
  concurrently.[^axum-ws]

Latency tail, which matters most for a karaoke game:

- **Rust** has no garbage collector, so it has no collector pauses.
- **Go** has a concurrent collector. The Go GC guide says it "is not fully
  stop-the-world and does most of its work concurrently", and that it "avoids
  making the length of any global application pauses proportional to the size of
  the heap". It lists the remaining latency sources: brief stop-the-world pauses
  at phase transitions, the collector taking 25% of CPU during marking, and
  goroutines assisting the collector under high allocation rates.[^go-gc]
- **Bun** runs on JavaScriptCore, which has a garbage collector.
  **Unverified:** I found no primary documentation of its pause times.
- In the TechEmpower HTTP data above, worst-case latency was 2 to 6 ms for the
  Rust entries, 10.8 ms for Bun and 6 to 45 ms for the non-prefork Go entries,
  all under loads thousands of times above OpenStar's.[^tfb-data]

Gaps:

- **Unverified:** no reproducible, recent, cross-language WebSocket benchmark
  with latency percentiles was found. TechEmpower has no WebSocket test.
- **Unverified:** pause behaviour of each runtime at OpenStar's actual load (a
  few hundred small messages per second at most).

**At home-server scale:** message throughput is irrelevant; a party sends
perhaps hundreds of messages per second against capacities in the hundreds of
thousands. The open question is whether collector pauses in Go or Bun are ever
long enough to be felt. **Inference:** with a live heap of a few megabytes,
pauses should be well under a millisecond in Go, and Wi-Fi jitter between a
Phone and the server is typically larger than that. This rests on no
measurement and depends on a decision outside this ticket: if pitch detection
runs on the Phone and only results travel, a pause of a few milliseconds is
absorbed by the timestamps.

## 4. yt-dlp and ffmpeg jobs

The work: start external processes, stream their output for progress, cancel
them, and not block the rest of the server.

- **Go.** `os/exec` with `CommandContext` ties a process to a cancellable
  context.[^go-exec]
- **Rust.** `tokio::process` gives asynchronous child processes. A child keeps
  running after its handle is dropped unless `kill_on_drop` is set, and the
  runtime reaps exited children on a best-effort basis.[^tokio-process]
- **Bun.** `Bun.spawn` uses `posix_spawn(3)`. Bun reports its `spawnSync` is 60%
  faster than Node.js `child_process`, at about 0.9 ms per spawn of `echo hi` on
  an Apple M1 Max.[^bun-spawn]

Spawn cost is under a millisecond; a download or transcode takes seconds to
minutes inside the child process. **At home-server scale the runtime does not
affect this work.**

What does matter comes from yt-dlp itself, and it applies to every candidate:

- yt-dlp supports Python 3.11 and later. The small `yt-dlp` release file (3.1 MB)
  needs a Python interpreter; the standalone Linux binaries (glibc and musl,
  41.2 MB each) do not.[^ytdlp-readme][^ytdlp-release]
- ffmpeg and ffprobe are "strongly recommended" and required for merging
  separate video and audio streams.[^ytdlp-readme]
- Full YouTube support needs the `yt-dlp-ejs` component and an external
  JavaScript runtime. Deno is recommended and enabled by default (minimum
  2.3.0). Node (minimum 22.0.0) and QuickJS must be enabled with
  `--js-runtimes`.[^ytdlp-ejs]
- **Bun support in yt-dlp is deprecated.** The wiki states: "Versions after
  1.3.14 are not supported, and support may be dropped entirely in the future."
  The current Bun release is 1.4.5 (2026-11-19).[^ytdlp-ejs][^bun-release] A Bun
  backend therefore cannot count on its own runtime doubling as yt-dlp's
  JavaScript runtime; the image needs Deno, Node or QuickJS in any case.
- With Bun as yt-dlp's runtime, scripts get "full file system and network
  access"; Deno runs them with restricted permissions.[^ytdlp-ejs]

## 5. Embedded database

All three candidates would use SQLite. SQLite's own guidance: it "competes with
`fopen()`", and sites with fewer than 100,000 hits per day "should work fine".
WAL mode "is significantly faster in most scenarios" and lets readers and a
writer proceed concurrently.[^sqlite-when][^sqlite-wal] OpenStar's database
(Songs index, Profiles, scores, Queue) is orders of magnitude below those
limits.

- **Rust.** `rusqlite` wraps the C library. Its `bundled` feature compiles and
  links a current SQLite into the binary, so no system library is
  needed.[^rusqlite]
- **Bun.** `bun:sqlite` is built in. On Linux Bun statically links its own
  SQLite build. Bun claims it is "roughly 3-6x faster than better-sqlite3" for
  read queries, measured on an M1 MacBook Pro with macOS 12.3.1 against the
  Northwind dataset. That is a vendor benchmark, several years old, against
  other JavaScript drivers only.[^bun-sqlite] The API is synchronous, so a slow
  query blocks the single JavaScript thread (inference from the documented
  synchronous API).
- **Go.** The choice of driver is a real trade-off. `mattn/go-sqlite3` wraps the
  C library through cgo, which requires a C toolchain at build time and rules
  out the simplest static builds. `modernc.org/sqlite` is SQLite's C code
  transpiled to Go, and `ncruces/go-sqlite3` runs a WebAssembly build; both
  avoid cgo.[^go-sqlite-bench] In the go-sqlite-bench results of 2026-03-23
  (Intel i7-1165G7, Go 1.26.0, times in milliseconds, lower is better):

  | Test | mattn (cgo) | modernc (pure Go) | ncruces (Wasm) |
  |---|---|---|---|
  | Simple: insert 1 M rows | 1480 | 2419 | 2719 |
  | Simple: query 1 M rows | 871 | 758 | 850 |
  | Complex: insert | 812 | 1554 | 1749 |
  | Complex: query | 998 | 1068 | 1263 |
  | Large: query, N=200,000 | 376 | 1094 | 528 |

  The author's summary: "We cannot declare a clear winner, it all depends on the
  use case" and "SQLite without CGO is possible nowadays". Each test was run
  twice and the better result recorded, which the author calls "not very
  scientific".[^go-sqlite-bench]

Gaps:

- **Unverified:** no primary benchmark compares rusqlite, `bun:sqlite` and the
  Go drivers on the same machine and workload.

**At home-server scale:** the pure-Go drivers are up to about 2 to 3 times
slower than cgo on bulk inserts, which for OpenStar means the difference between
inserting 30,000 Songs after a scan in tens of milliseconds or somewhat more
(inference from the 1 M row timings above). No user would notice. The Go driver
choice affects the build and the image more than the speed.

## Memory

- In the Benchmarks Game, small Rust and Go programs peak at roughly 3 to 5 MB
  (for example n-body: Rust 3.0 MB, Go 3.2 MB), while the Node.js programs for
  the same tasks peak at 64 to 111 MB.[^bg-rust-go][^bg-go-node] That shows the
  baseline cost of a JavaScript runtime. Bun is not measured there.
- Go's heap overhead is tunable: with the default `GOGC=100` the target heap is
  about twice the live heap, and `GOMEMLIMIT` sets a ceiling.[^go-gc]
- **Unverified:** idle and working memory of a Bun server. I found no primary
  figure.

**At home-server scale:** a difference of 50 to 100 MB is real but small beside
ffmpeg, the Stage browser's own needs or the host's total memory.

## Container image size

Compressed sizes for linux/amd64 from Docker Hub and GitHub releases on
2026-11-24:

| Item | Size | Source |
|---|---|---|
| `alpine:latest` | 3.9 MB | [^hub] |
| `debian:stable-slim` | 29.8 MB | [^hub] |
| `chainguard/static` (for static binaries) | 0.46 MB | [^hub] |
| `oven/bun:alpine` | 57.3 MB | [^hub] |
| `oven/bun:distroless` | 58.4 MB | [^hub] |
| `oven/bun:slim` | 83.6 MB | [^hub] |
| `oven/bun:latest` | 104.3 MB | [^hub] |
| Bun release `bun-linux-x64.zip` | 51.3 MB | [^bun-release] |
| `denoland/deno:latest` | 72.9 MB | [^hub] |
| Deno release zip, linux x86_64 | 42.0 MB | [^deno-release] |
| `node:22-slim` | 79.9 MB | [^hub] |
| `python:3.13-slim` | 43.1 MB | [^hub] |
| yt-dlp standalone Linux binary | 41.2 MB | [^ytdlp-release] |
| `linuxserver/ffmpeg:latest` | 270.5 MB | [^hub] |

- Rust and Go compile to a single binary that can run on a minimal base such as
  distroless `static`, which holds only CA certificates, a passwd entry, `/tmp`
  and tzdata. Go binaries that use cgo need a base with glibc
  instead.[^distroless] **Unverified:** the size of an actual OpenStar binary in
  either language; typical server binaries are in the range of 10 to 30 MB.
- Bun needs its runtime in the image: 57 to 104 MB compressed depending on the
  base.[^hub] **Unverified:** the size of a `bun build --compile` executable; I
  could not load that documentation page.
- The build images (`rust:slim` 329 MB, `golang:alpine` 75 MB) are only used in
  a build stage and do not ship.[^hub]

**At home-server scale:** the tools decide the image size. yt-dlp, a JavaScript
runtime for it and ffmpeg add roughly 100 to 350 MB compressed whichever backend
is chosen. The backend's own share is between about 1% and 30% of the image. On
a home server that pulls the image once per update, this does not matter.

## Ecosystem fit

Facts that are not performance but came up in the same sources:

- The owner's existing USDB downloader is Bun/TypeScript (stated in issue #1).
  Reusing it directly is only possible on Bun or Node.
- Bun bundles the HTTP server, WebSockets, SQLite, file serving with ranges and
  process spawning in the runtime, with no third-party packages.[^bun-ws][^bun-sqlite][^bun-routing][^bun-spawn]
- Go has HTTP, range-aware file serving, process handling and directory walking
  in the standard library, and needs third-party packages for WebSockets and
  SQLite.[^go-http][^go-exec][^go-filepath][^coder-ws][^go-sqlite-bench]
- Rust needs crates for all of these: axum, tower-http, tokio and
  rusqlite.[^axum-ws][^tower-servedir][^tokio-process][^rusqlite]
- Current versions: Go 1.27.4, Bun 1.4.5.[^go-version][^bun-release]

## Other candidates

- **Node.js.** About half of Bun's throughput in the TechEmpower JSON test
  (1.15 M against 2.10 M requests per second).[^tfb-data] It is the JavaScript
  runtime yt-dlp still supports without a deprecation notice.[^ytdlp-ejs]
- **Deno.** 1.81 M requests per second in the same test.[^tfb-data] It is
  yt-dlp's recommended runtime, so a Deno backend would share one runtime with
  yt-dlp.[^ytdlp-ejs] **Unverified:** Deno's SQLite and WebSocket performance; I
  did not research them.
- **C# (ASP.NET Core).** 2.55 M requests per second, level with Rust and the
  fastest Go entries.[^tfb-data] Not researched further.
- **Elixir (Phoenix).** 0.54 M requests per second.[^tfb-data] Built for
  real-time messaging, but not researched further.

## What is too close to matter, and what is not

Too close to matter for one room and a handful of clients, according to the
sources above: HTTP throughput, media serving, process spawning, SQLite speed,
image size.

Not settled by published sources, and worth a measurement before the decision:

1. Scan time of the real Library on the real storage, per runtime.
2. Worst-case delay of a relayed WebSocket message under realistic load, per
   runtime.
3. Idle and working memory of a minimal server, per runtime.

Fixed facts that hold whichever runtime is chosen:

1. The image carries yt-dlp, ffmpeg and a JavaScript runtime for yt-dlp, and
   that runtime should not be Bun.
2. Phones need HTTPS for the microphone, so TLS is terminated somewhere, and
   zero-copy file sending does not survive in-process TLS.
3. The database is SQLite at a scale where every driver is fast enough.

[^tfb-repo]: GitHub API, `repos/TechEmpower/FrameworkBenchmarks`: `archived: true`, `pushed_at: 2026-03-24`. <https://github.com/TechEmpower/FrameworkBenchmarks>
[^tfb-r23]: TechEmpower, "Framework Benchmarks Round 23", 2025-03-17. <https://www.techempower.com/blog/2025/03/17/framework-benchmarks-round-23/>
[^tfb-data]: TechEmpower Round 23 raw results, run `91a66052-9d86-446c-b31a-eadbd669ed08`, `rawData.json`, best `totalRequests` divided by the 15 s duration. <https://www.techempower.com/benchmarks/results/round23/ph.json> (viewer: <https://www.techempower.com/benchmarks/#section=data-r23>)
[^tfb-actix]: TechEmpower maintainer comment in the Round 23 issue. <https://github.com/TechEmpower/FrameworkBenchmarks/issues/9589>
[^go-filepath]: Go `path/filepath` documentation, `Walk` and `WalkDir`. <https://pkg.go.dev/path/filepath>
[^walkdir]: `walkdir` crate documentation. <https://docs.rs/walkdir/latest/walkdir/>
[^tokio-fs]: `tokio::fs` module documentation, including "Tuning your file IO". <https://docs.rs/tokio/latest/tokio/fs/index.html>
[^bun-glob]: Bun documentation, "Glob". <https://bun.com/docs/runtime/glob.md>
[^bg-how]: The Computer Language Benchmarks Game, "How programs are measured". <https://benchmarksgame-team.pages.debian.net/benchmarksgame/how-programs-are-measured.html>
[^bg-rust-go]: Benchmarks Game, Rust versus Go. <https://benchmarksgame-team.pages.debian.net/benchmarksgame/fastest/rust-go.html>
[^bg-go-node]: Benchmarks Game, Go versus Node.js. <https://benchmarksgame-team.pages.debian.net/benchmarksgame/fastest/go-node.html>
[^go-http]: Go `net/http` documentation, `ServeContent`. <https://pkg.go.dev/net/http#ServeContent>
[^go-sendfile]: Go source, `src/net/http/server.go`, comment on `(*response).ReadFrom`. <https://github.com/golang/go/blob/master/src/net/http/server.go>
[^bun-routing]: Bun documentation, HTTP "Routing" (file responses, range requests, `sendfile`). <https://bun.com/docs/runtime/http/routing.md>
[^bun-fileio]: Bun documentation, "File I/O", system call table. <https://bun.sh/docs/api/file-io>
[^tower-servedir]: tower-http documentation, `ServeDir` (`with_buf_chunk_size`, `ignore_multi_range_requests`). <https://docs.rs/tower-http/latest/tower_http/services/fs/struct.ServeDir.html>
[^mdn-gum]: MDN, `MediaDevices.getUserMedia()`, secure context note. <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia>
[^bun-ws]: Bun documentation, "WebSockets". <https://bun.sh/docs/api/websockets>
[^coder-ws]: `coder/websocket` README. <https://github.com/coder/websocket>
[^gorilla-ws]: `gorilla/websocket` README. <https://github.com/gorilla/websocket>
[^axum-ws]: axum documentation, `extract::ws`, and its dependency list (`tokio-tungstenite`). <https://docs.rs/axum/latest/axum/extract/ws/index.html>
[^go-gc]: "A Guide to the Go Garbage Collector". <https://go.dev/doc/gc-guide>
[^go-exec]: Go `os/exec` documentation. <https://pkg.go.dev/os/exec>
[^tokio-process]: `tokio::process` module documentation. <https://docs.rs/tokio/latest/tokio/process/index.html>
[^bun-spawn]: Bun documentation, "Spawn", benchmarks section. <https://bun.sh/docs/api/spawn>
[^ytdlp-readme]: yt-dlp README, "Release files" and "Dependencies". <https://github.com/yt-dlp/yt-dlp#dependencies>
[^ytdlp-release]: yt-dlp release 2026.11.23, asset sizes from the GitHub API. <https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.23>
[^ytdlp-ejs]: yt-dlp wiki, "EJS". <https://github.com/yt-dlp/yt-dlp/wiki/EJS>
[^bun-release]: Bun release `bun-v1.4.5`, 2026-11-19, asset sizes from the GitHub API. <https://github.com/oven-sh/bun/releases/tag/bun-v1.4.5>
[^sqlite-when]: SQLite, "Appropriate Uses For SQLite". <https://www.sqlite.org/whentouse.html>
[^sqlite-wal]: SQLite, "Write-Ahead Logging". <https://www.sqlite.org/wal.html>
[^rusqlite]: `rusqlite` README. <https://github.com/rusqlite/rusqlite>
[^bun-sqlite]: Bun documentation, "SQLite". <https://bun.sh/docs/api/sqlite>
[^go-sqlite-bench]: `cvilsmeier/go-sqlite-bench` README, results of 2026-03-23. <https://github.com/cvilsmeier/go-sqlite-bench>
[^hub]: Docker Hub tag API (`hub.docker.com/v2/repositories/<repo>/tags/<tag>`), amd64 compressed image size, read 2026-11-24. For example <https://hub.docker.com/r/oven/bun/tags>
[^deno-release]: Deno release v2.9.8, 2026-10-21, asset size from the GitHub API. <https://github.com/denoland/deno/releases/tag/v2.9.8>
[^distroless]: GoogleContainerTools distroless, base image README. <https://github.com/GoogleContainerTools/distroless/blob/main/base/README.md>
[^go-version]: <https://go.dev/VERSION?m=text>, read 2026-11-24.
