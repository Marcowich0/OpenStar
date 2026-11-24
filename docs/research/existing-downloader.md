# How the existing downloader gets songs

Research for issue #7. Researched 2026-11-24.

## Sources

| Tag | Source | Version read |
| --- | --- | --- |
| **[U]** | Source of `github.com/Marcowich0/ultrastar` | commit [`39fcb8d`](https://github.com/Marcowich0/ultrastar/tree/39fcb8de5c577f2cb519c2319d321e9176372691) (2026-11-02). Paths below are relative to that tree. |
| **[UP]** | Its upstream, `github.com/martiinii/ultrastar` | merge base `d156953` (2025-05-07) |
| **[USDB]** | `usdb.animux.de`, public pages only | 3 manual, logged-out GETs on 2026-11-24: `/robots.txt`, `/`, `/?link=lizenz` |
| **[YT]** | yt-dlp `README.md` | master `6f73a8d` (latest release `2026.11.23`) |
| **[SY]** | `github.com/bohning/usdb_syncer`, `src/usdb_syncer/usdb_scraper.py` | main `1a4b048`. A second, independent USDB client, used only as a cross-check. |

No login to USDB was made and none of the downloader's requests were replayed.
So everything said about the **shape of USDB's logged-in pages** is what the code
expects, not something observed. Those points are marked **unverified**.

## Answer in short

The downloader logs in to USDB with a username and password, scrapes the whole
song list once into SQLite, and serves search from that local copy. A download
scrapes the song's `.txt` out of the edit page, picks a YouTube video (first
video embedded in the song's USDB comments, else the first `yt-dlp` search hit),
writes a folder `Artist - Title/` with `song.txt`, `cover.jpg`, `metadata.json`,
and has `yt-dlp` download one `video.mp4` that serves as both audio and video.

OpenStar can reuse the **knowledge** (endpoints, form fields, parsing rules, the
`yt-dlp` invocation, the folder convention) and the owner's own code (queue,
reconcile). It cannot take the USDB package as a dependency: it is Bun-only,
unbuilt, untested, and upstream code with no licence.

## 1. Repository layout

The repo is a fork of `martiinii/ultrastar` with six commits by the owner on top
(`git log`, **[U]**). Bun workspaces plus Turborepo (`package.json`).

| Part | What it is | Origin |
| --- | --- | --- |
| `packages/ultrastar-api` | USDB login, scraping, parsing. 391 lines. | Upstream, **untouched by the fork** (`git diff upstream/main HEAD -- packages/ultrastar-api` is empty) |
| `packages/youtube-api` | `yt-dlp` search, download, queue. 245 lines. | Upstream, largely rewritten by the owner; `ytDlpQueue.ts` is new |
| `packages/types` | Ambient global types (`Song`, `Page`, `Metadata`, `YoutubeVideo`) | Upstream |
| `apps/api` | Elysia HTTP API on port 3001, SQLite through Drizzle | Upstream; owner added `config.ts`, `services/downloadJobs.ts`, `services/reconcileDownloadedSongs.ts` |
| `apps/web` | Next.js frontend | Upstream plus owner pages |
| `Dockerfile`, `docker/`, `compose.yml` | One container: nginx on 8080 in front of web (3000) and API (3001) | Owner |

The container already uses the two volumes OpenStar has settled on: `/appdata`
(holds `sqlite.db`) and `/songs` (`apps/api/src/config.ts:8-14`, `Dockerfile:58`).

## 2. USDB login

`packages/ultrastar-api/src/lib/login/login.ts`:

- `POST https://usdb.animux.de/index.php?link=login` with form fields
  `user`, `pass`, `login=Login` (lines 4-9). **[SY]** sends the same three fields
  (`usdb_scraper.py:193`), which corroborates the form.
- Credentials come from `ULTRASTAR_USERNAME` and `ULTRASTAR_PASSWORD`, read with
  `Bun.env` **at module import** (lines 7-8).
- The session is the first `name=value` pair of the response's `Set-Cookie`
  header, kept in a module variable (lines 11, 22).
- `loggedFetcher` logs in only when that variable is empty (line 32).

Weaknesses, all read directly from the code:

- Login success is never checked. A wrong password still stores a cookie.
- The cookie is never refreshed. Once the session expires, scraped pages are
  login pages, `parseLyrics` finds no `<textarea>` and returns `null`, and the
  download route answers `400 "Song not found"` (`routers/songs.ts:68-69`) until
  the process restarts.
- A logged-out GET of `/` on 2026-11-24 set `PHPSESSID` with `Max-Age=604800`
  (7 days) **[USDB]**. That the login cookie is this same cookie with this same
  lifetime is **unverified**.

Which requests use the login:

| Request | Logged in? | File |
| --- | --- | --- |
| Song list, `POST /?link=list` | yes | `scrapper/searchPage.ts:26-37` |
| Song text, `GET /?link=editsongs&id=<id>` | yes | `scrapper/lyricsPage.ts:9-15` |
| Song detail and comments, `GET /?link=detail&id=<id>` | no | `scrapper/songPage.ts:8-14` |
| Cover, `GET /data/cover/<id>.jpg` | no | `data/image.ts:3-10` |

## 3. USDB scraping and parsing

All parsing is regular expressions over HTML strings; there is no HTML parser and
no dependency (`packages/ultrastar-api/package.json` has no runtime dependencies).
Fetching (`lib/scrapper`) and parsing (`lib/parser`) are separate: every parser is
a pure `html => data` function.

**Song list** (`scrapper/searchPage.ts`, `parser/parseSongsFromSearch.ts`,
`parser/parseSongFromTable.ts`)

- Form body: `order=id`, `ud=asc`, `limit=100`, `start=(page-1)*100`.
- Page count from the text `There are N results on M page`.
- Rows are `<tr class="list_tr1|2">`. Song id from `show_detail(<id>)`. Cells by
  position: 0 artist, 1 title, 4 languages (lowercased, split on `", "`).
- No search term is ever sent. The downloader only walks the full list.
  **[SY]** uses the same paged list with a `limit` field (`usdb_scraper.py:426-436`).

**Song text** (`parser/parseLyrics.ts`)

- Takes the content of the first `<textarea>` on the **edit** page
  (`link=editsongs`), not a download endpoint. **[SY]** uses `link=gettxt` instead
  (`usdb_scraper.py:628-635`); which of the two an ordinary account may open is
  **unverified**.
- Header lines match `^#(.*:.*)$`. Each is split on `:` and only the first two
  parts are kept (line 16), so **a value containing a colon is cut at the colon**
  (`#TITLE:Re: Stacks` becomes `Re`). Keys are lowercased into a `Map`; a header
  with an empty value is dropped.
- `metadata` = artist, title, year, languages, taken from those headers.
- `lyrics` = the text with all header lines removed.
- Nothing decodes HTML entities in the textarea content. Whether USDB escapes
  them (`&amp;`, `&#039;`) is **unverified**; if it does, they land in the file.

**YouTube links** (`parser/parseComments.ts`, `parser/parseYoutubeLinks.ts`)

- Comments are found by a date pattern `DD.MM.YY - HH:MM` in a `<td>`.
- Within a comment, the `src="http…"` of an embed containing `youtube`/`youtu.be`
  is taken, and the link is its last path segment (the video id, plus any query
  string the embed carried).
- Result is in page order. Whether that is newest or oldest first is **unverified**.
- The `#VIDEO` header of the USDB text is not used as a video source; it is
  overwritten (section 6).

## 4. Catalogue sync and stored metadata

`POST /api/sync/download/:page?` (`apps/api/src/routers/sync.ts:22-103`) walks the
list from the given page to the end, 100 songs per request, strictly one page
after another, and streams progress.

- For each song: `INSERT … ON CONFLICT DO NOTHING` on `api_id`. Only a **new**
  song then gets its cover fetched and its languages linked.
- Existing songs are never updated and songs removed from USDB are never deleted.
- `year` is never written by the sync, so the column stays `NULL`.
- The transaction callback is `async` and is not awaited (`sync.ts:34`), so the
  cover requests of a page are not serialised by the loop. The exact runtime
  behaviour with the `libsql` driver is **unverified**.
- There is **no delay, no rate limit and no retry** towards USDB anywhere.
- The upstream README puts a full sync at 5 to 20 minutes and the resulting
  database at over 200 MB, mostly covers (`README.md:116-118`). Song ids on USDB's
  home page reach about 32,700 **[USDB]**, so a full sync is in the order of 330
  list requests plus one cover request per song (my estimate).

Schema (`apps/api/src/db/index.ts:9-41`, mirrored in `db/schema/songs.ts`):

| Table | Columns | Note |
| --- | --- | --- |
| `song` | `id` TEXT PK (cuid2), `api_id` INTEGER UNIQUE (USDB id), `artist`, `title`, `year` INTEGER NULL, `image` BLOB (cover JPEG), `download_status` (`available` / `loading` / `complete`) | Covers live inside SQLite |
| `language` | `id` TEXT PK, `language` TEXT UNIQUE | |
| `song_language` | `song_id`, `language_id` | join table |
| `video`, `song_video` | `id`, `video_link` / join | **defined but never read or written** |

Search (`db/query/getSongs.ts`) is a local `LIKE %term%` on title and artist with
an optional language filter, 100 per page, ordered by title. There is no live
search against USDB.

## 5. Resolving and downloading media with yt-dlp

**Which video** (`routers/songs.ts:96-110`): the first YouTube link from the
song's USDB comments; if there is none, the first result of a YouTube search for
`"<artist> - <title>"`. The user is not shown the choice. A "Change video" button
exists in the web app but has no behaviour
(`apps/web/components/feature/songs/buttons/changeVideoButton.tsx`).

**Search** (`packages/youtube-api/src/lib/searchYoutube.ts:6`):

```
yt-dlp --match-filters 'original_url!*=/shorts/' "ytsearch5:<query>" --flat-playlist -j --no-simulate
```

Five results, Shorts excluded, one JSON object per line. `ytsearch:` is a
documented search prefix, `--flat-playlist` skips full extraction of each entry,
`-j` prints JSON **[YT]**.

**Download** (`packages/youtube-api/src/lib/downloadYoutubeVideo.ts:36-50`):

```
yt-dlp [--extractor-args youtube:player_client=tv,web_embedded] --newline \
  --progress-template "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s" \
  -S ext,res:1080 -o <folder>/video.mp4 -- <video id>
```

- No `-f`, so the default selection applies: best video plus best audio, merged,
  "generally equivalent to `-f bestvideo*+bestaudio/best`" **[YT, Format
  Selection]**. Merging needs ffmpeg **[YT, Dependencies]**; the image installs it
  (`Dockerfile:28`).
- `-S ext,res:1080` sorts first by container (`mp4 > mov > webm`, audio
  `m4a > aac > mp3 …`), then by resolution, preferring the largest up to 1080p
  **[YT, Sorting Formats]**. It is a preference, not a filter.
- The output name is the literal `video.mp4`. What file name results when the
  chosen formats cannot be merged into MP4 is **unverified**.
- **No separate audio file is produced.** `#MP3` and `#VIDEO` both point at
  `video.mp4` (section 6).
- Progress is parsed from the template lines, which is the approach yt-dlp
  recommends over parsing normal output **[YT, Embedding]**.
- On stderr containing `HTTP Error 403: Forbidden`, a process-wide flag switches
  all later attempts to `player_client=tv,web_embedded` (lines 27, 86-91). Both
  are listed YouTube clients **[YT, Extractor Arguments]**.
- The image pins yt-dlp `2026.07.04` and installs Deno `2.5.0`
  (`Dockerfile:33-43`). yt-dlp states that `yt-dlp-ejs` plus a JavaScript runtime
  is "required for full YouTube support" and that only Deno is enabled by default
  **[YT, Dependencies; `--js-runtimes`]**. The pin is four months behind the
  current release.

## 6. What is written into the Library

`GET /api/songs/:id/download` (`routers/songs.ts:49-221`) writes, under
`/songs/<artist> - <title>/` (artist and title from the database row, line 77):

| File | Content |
| --- | --- |
| `song.txt` | Every scraped header as `#KEY:value` (key uppercased, source order), then the note lines. `#MP3`, `#VIDEO` are forced to `video.mp4`, `#COVER` to `cover.jpg` (lines 115-127). |
| `cover.jpg` | The cover blob from SQLite, or a **zero-byte file** when there is none (line 132). |
| `metadata.json` | `{"id": "<local cuid>", "apiId": <USDB id>}` (line 138). |
| `video.mp4` | Written afterwards by yt-dlp. |

Facts that matter for OpenStar, which reads this same folder:

- The folder name is **not sanitised**. A `/` in an artist or title (`AC/DC`)
  creates a nested folder; other characters illegal on the host are passed through.
- On any failure the handler runs `rm -rf` on the song folder (lines 196, 217).
  If a folder of that name already existed in the Library, **it is deleted**.
  Whether a song is "already downloaded" is decided from the database status
  alone (lines 63-66), never from the folder.
- Files are written as UTF-8 with no BOM; no `#VERSION` or `#AUDIO` header is
  added. A `#BACKGROUND` header from USDB is kept although no background file is
  fetched.
- Songs this downloader wrote can be recognised and mapped back to a USDB id
  through `metadata.json`.

## 7. Jobs, concurrency and progress

There are two separate mechanisms.

**Job registry** (`apps/api/src/services/downloadJobs.ts`): an in-memory
`Map<songId, job>` with `status: "loading"`, `phase: "preparing" | "downloading"`,
`progress`, `speed`, `eta`. Listed by `GET /api/songs/downloads`. It is not
persisted. After a crash the job is gone while the row still says `loading`, and
that song refuses to download (`409`) until a reconcile resets it.

**yt-dlp queue** (`packages/youtube-api/src/lib/ytDlpQueue.ts`): an in-process
promise queue shared by searches and downloads.

| Setting | Env var | Default |
| --- | --- | --- |
| Concurrent yt-dlp processes | `ULTRASTAR_DOWNLOAD_CONCURRENCY` | 2 |
| Retries after the first attempt | `ULTRASTAR_DOWNLOAD_RETRIES` | 2 |
| Base delay, doubled each retry | `ULTRASTAR_DOWNLOAD_RETRY_DELAY_MS` | 1500 |

Only yt-dlp calls go through it. USDB requests are not queued or limited.

**Flow of one download** (`routers/songs.ts`): the USDB text, the video choice and
the three small files are done inside the HTTP request; the request then returns
`"Downloading..."` and the video download continues in the background. Progress
goes to every connected browser over one WebSocket topic (`routers/ws.ts`),
throttled to one message per 500 ms per job. End states are `complete` or `error`;
there is no cancel.

**Reconcile** (`services/reconcileDownloadedSongs.ts`, owner's code, the only
tested module): scans each folder under `/songs`, requires a non-empty `.txt` and
a non-empty video file, matches the folder to a database row by `apiId`, then
local `id`, then normalised artist plus title, rewrites `metadata.json` when
stale, and resets every row's status to match.

The API has **no authentication**, and the download is triggered by a `GET`
(`routers/songs.ts:49`). CORS allows only `localhost` origins (`index.ts:15-17`).

## 8. Is the USDB logic usable as a library?

Not as a dependency. Reasons, all from **[U]**:

- **No licence.** Neither the fork nor the upstream has a licence file; GitHub
  reports `license: null` for both. `packages/ultrastar-api` is entirely the
  upstream author's code, so no right to copy it has been granted. (The owner's
  own files are theirs to reuse.)
- **Bun-only.** `Bun.env`, `Bun.spawn`, the `Bun.$` shell and `Bun.file` are used
  directly (`login.ts:7`, `downloadYoutubeVideo.ts:51`, `searchYoutube.ts:6`).
- **Not a real package.** `private`, version `0.0.0`, `main` points at TypeScript
  source, types are ambient globals from `packages/types`, and `apps/api` imports
  a deep path (`@ultrastar/ultrastar-api/src/lib/data`).
- **Global state.** One hard-coded credential pair and one cookie per process.
- **No tests** for any scraper or parser.

What is worth carrying over:

| Reuse | From |
| --- | --- |
| The USDB endpoints, form fields and page landmarks, as a specification for a rewrite (about 400 lines to replace) | sections 2 and 3 |
| The fetch / parse split, which makes parsers testable against saved HTML | `lib/scrapper`, `lib/parser` |
| The yt-dlp invocation, the progress template, the 403 client fallback, the concurrency and backoff queue | section 5, section 7 |
| The reconcile matching order (USDB id, then artist plus title) and `metadata.json` | section 7 |
| The image recipe: pinned yt-dlp binary, ffmpeg, Deno | `Dockerfile` |

What a rewrite must fix: colon-truncated header values, missing login check and
re-login, no throttling of USDB, unsanitised folder names, `rm -rf` of a
pre-existing folder, covers stored as blobs, no way to choose or change the video,
no audio-only file.

## 9. USDB's terms and rate limits

Everything USDB publishes, as found on 2026-11-24 **[USDB]**:

- The registration link leads to a "Licence Agreement" page (`/?link=lizenz`)
  whose full text is: *"With the registration I accept that all my data will be
  saved and checked. We offer only txt-files on our page. We do NOT offer Audio
  or Video files."*
- `/robots.txt` returns `404`. There is no crawler policy.
- The home page links no terms of service, API documentation, or rate-limit
  statement. The only other informational link is a password-recovery help page.

So: **no rate limit and no rule on automated access is published**, in either
direction. Whether USDB throttles or bans in practice is **unverified**, and
nothing was tested. Pages only visible after login were not read and may say more.

An account is required for the list and the text (section 2). USDB itself
provides text files only; audio and video come from YouTube through yt-dlp.
YouTube's terms were outside this ticket and were not researched.

## Not verified

- The HTML of USDB's logged-in pages (list table, edit-page textarea).
- Whether an ordinary account can open `link=editsongs` for any song.
- Which cookie carries the login and how long it lasts.
- HTML-entity escaping and character encoding of the scraped text.
- Order of comments on the detail page.
- yt-dlp's output file name when MP4 merging is not possible.
- Runtime behaviour of the un-awaited async transaction in the sync.
- Any enforced USDB rate limit.
