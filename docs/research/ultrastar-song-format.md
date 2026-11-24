# UltraStar song format and library conventions

Research for issue #2. Question: what must OpenStar read and write to be compatible with real UltraStar libraries?

Researched 2026-11-24. Every claim cites one of the sources below. Claims marked **unverified** could not be confirmed from a primary source. USDX behaviour was read from source, not run.

## Sources

| Key | Source | Pinned at |
| --- | --- | --- |
| SPEC-U | [The UltraStar File Format (Unversioned)](https://github.com/UltraStar-Deluxe/format/blob/7328e4df4ad9b88cb7120d4c9d8177a87945a57c/The%20UltraStar%20File%20Format%20(Unversioned).md) | format repo `7328e4d` |
| SPEC-1 | [The UltraStar File Format (v1)](https://github.com/UltraStar-Deluxe/format/blob/7328e4df4ad9b88cb7120d4c9d8177a87945a57c/The%20UltraStar%20File%20Format%20(v1).md) | format repo `7328e4d` |
| SPEC-2 | [The UltraStar File Format (v2)](https://github.com/UltraStar-Deluxe/format/blob/7328e4df4ad9b88cb7120d4c9d8177a87945a57c/The%20UltraStar%20File%20Format%20(v2).md), unpublished draft | format repo `7328e4d` |
| VERS | [VERSIONING.md](https://github.com/UltraStar-Deluxe/format/blob/7328e4df4ad9b88cb7120d4c9d8177a87945a57c/VERSIONING.md) | format repo `7328e4d` |
| WEB | [usdx.eu/format](https://usdx.eu/format/), which states "VERSION: 1.1.0, last update 21 Nov 2023" | fetched 2026-11-24 |
| USDX | [UltraStar Deluxe source](https://github.com/UltraStar-Deluxe/USDX/tree/e06b7b7ceff13612f6c5f716b4acedadd4a5f141), `master` | `e06b7b7` |
| SYNCER | [USDB Syncer source](https://github.com/bohning/usdb_syncer/tree/1a4b0488cdcb1f68eb486c7c0d7987ee7aa141b9) | `1a4b048` |
| OWNER | [Marcowich0/ultrastar](https://github.com/Marcowich0/ultrastar/tree/39fcb8de5c577f2cb519c2319d321e9176372691), the owner's downloader | `39fcb8d` |
| MDN-C | [MDN: Media container formats](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) | fetched 2026-11-24 |
| MDN-A | [MDN: Web audio codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs) | fetched 2026-11-24 |
| MDN-V | [MDN: Web video codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs) | fetched 2026-11-24 |
| CHROMIUM | [chromium.org: Audio/Video](https://www.chromium.org/audio-video/) | fetched 2026-11-24 |

USDX file references below are paths under `src/` at the pinned commit, with line numbers.

## Answer in short

- A Song is one `.txt` file: `#KEY:value` header lines, then a body of note lines, end-of-phrase lines and voice changes, ended by `E` (SPEC-1 §2).
- Three format generations exist. Unversioned (no `#VERSION`) and 1.x share one syntax and one set of units. 2.0.0 is an unpublished draft that changes units and removes `#MP3`; USDX refuses to load it (SPEC-2 "Status"; USDX `base/USong.pas:1133`).
- USDX is far more lenient than the spec in some places (encodings, decimal commas, unknown lines) and stricter in others (an empty line in the body aborts the load, a missing audio file rejects the Song).
- Real libraries hold MP3, M4A, Ogg and Opus audio and MP4, WebM, AVI, MKV and other video. Chromium plays the modern ones natively; legacy AVI, DivX, MPEG and WMV video needs transcoding or is skipped.

## 1. File structure

- Plain text, extension `.txt` (SPEC-U §2, SPEC-1 §2).
- Header first, then body. A file should end with a line holding `E`; everything after it is ignored (SPEC-1 §2). USDX also accepts end of file without `E` (`base/USong.pas:781`, `:848`).
- Line endings: CR, LF or CRLF are all valid; LF is recommended for writing (SPEC-1 §2.1). USDX's reader accepts all three (`base/UPath.pas:1312-1331`).
- The spec says empty and whitespace-only lines are ignored everywhere (SPEC-1 §2.1). USDX does not follow this: see section 7.
- Header syntax: `#`, key, `:`, value. Whitespace around key and value is ignored. Keys compare case-insensitively. An empty value equals an absent header. Unknown headers must be ignored (SPEC-1 §3, §3.1).
- File references (`#MP3`, `#AUDIO`, `#VIDEO`, `#COVER`, `#BACKGROUND`, `#VOCALS`, `#INSTRUMENTAL`) are relative to the `.txt`. Absolute paths should be refused (SPEC-1 §3.2). Case sensitivity of the file system matters (SPEC-1 §3.2 note); USDX does an exact `IsFile` check with no case folding (`base/USong.pas:996`).

## 2. Format versions

| Version | Marker | Status | Source |
| --- | --- | --- | --- |
| Unversioned | no `#VERSION` | archived, the bulk of existing files | VERS "History"; format README |
| 1.0.0 | `#VERSION:1.0.0` | published 2023-12-01 | SPEC-1 revision history |
| 1.1.0 | `#VERSION:1.1.0` | "for historical reasons equivalent to 1.0.0" | SPEC-1 "Status" |
| 1.2.0 | `#VERSION:1.2.0` | written by USDB Syncer (adds `#AUDIOURL` and the other URL headers, drops `#MP3`). Not named in the spec repo: **unverified** as an official version | SYNCER `src/usdb_syncer/settings.py:322-327`, `song_loader.py:975-984` |
| 2.0.0 | `#VERSION:2.0.0` | unpublished draft, may still change | SPEC-2 "Status" |

- Version check per the spec: a syntactically invalid `#VERSION` makes the file invalid; an unknown major version must be refused; a higher minor version loads with a warning (VERS "Practical Guidance").
- USDX: unversioned files get internal version 0.3.0 (`base/USong.pas:279-286`). An invalid `#VERSION` rejects the Song (`:1118-1131`). Any version at or above 2.0.0 rejects the Song (`:1133-1138`).
- Conflict between sources: WEB advertises for 1.1.0 "all time attributes use milliseconds now" in its feature list, while its own attribute sections and SPEC-1 keep `#START`, `#VIDEOGAP` and `#PREVIEWSTART` in seconds. SPEC-1 and USDX agree with each other, so treat 1.x as seconds. The millisecond change is real only in the 2.0.0 draft (SPEC-2 §3.3.7, A.3, A.4).

## 3. Header tags

Units are what makes a file sing in time, so they are listed per generation. "USDX" is what the reference implementation does today.

### Core

| Tag | Unversioned / 1.x | 2.0.0 draft | USDX behaviour |
| --- | --- | --- | --- |
| `#VERSION` | absent / required, `1.y.z` (SPEC-1 §3.3.1) | required | see section 2 |
| `#TITLE` | required (SPEC-U §3.5) | required | required, else Song rejected (`base/USong.pas:1463-1476`) |
| `#ARTIST` | required (SPEC-U §3.6) | required | required |
| `#MP3` | required audio file reference (SPEC-U §3.4, SPEC-1 §3.3.3) | removed | read in every version below 2 (`:1205-1209`) |
| `#AUDIO` | 1.x only: optional, wins over `#MP3` even if its file is missing (SPEC-1 A.1) | required, replaces `#MP3` (SPEC-2 §3.3.3) | read only when version is 1.0.0 or higher; an unversioned file with only `#AUDIO` is rejected (`:1183-1203`) |
| `#BPM` | required decimal, `.` or `,`; value is implicitly quadrupled, so real beats per minute is `BPM x 4` (SPEC-U §3.3, SPEC-1 §3.3.2) | decimal with `.` only; the quadrupling sentence is gone, and VERS lists its removal as the example of a breaking change | `BPM x 4`, accepts `,`; below 1 after scaling is invalid and rejects the Song (`:1211-1230`, `:70`) |
| `#GAP` | milliseconds from audio start to beat 0, decimal allowed (SPEC-U §3.8) | integer milliseconds (SPEC-2 §3.3.6) | float ms, `,` accepted (`:1236-1241`); time of a beat is `GAP/1000 + beat x 60 / (BPM x 4)` (`base/UNote.pas:258-271`) |
| `#START` | **seconds**, decimal (SPEC-U §3.10) | **milliseconds**, integer (SPEC-2 §3.3.7) | float seconds (`:1318-1323`) |
| `#END` | **milliseconds** (SPEC-U §3.10) | milliseconds, integer | integer only; a decimal value is silently dropped (`:1325-1330`) |
| `#P1` .. `#P9` | voice names; unversioned defines only `#P1`, `#P2` (SPEC-U §3.17); 1.x defines `#P1`..`#P9`, required for each voice used (SPEC-1 §3.3.8) | same as 1.x | only `P1`, `P2` (`:1437-1449`) |

### Extended (all optional)

| Tag | Unversioned / 1.x | 2.0.0 draft | USDX |
| --- | --- | --- | --- |
| `#COVER`, `#BACKGROUND` | image file reference (SPEC-U §3.7) | same | stored, no existence check (`:1243-1255`) |
| `#VIDEO` | video file reference (SPEC-U §3.7) | same | if file missing: logged, Song still loads without video (`:1257-1266`) |
| `#VIDEOGAP` | **seconds**, signed decimal; negative skips into the video (SPEC-U §3.9) | **milliseconds**, signed integer (SPEC-2 A.3) | float seconds; video position = `VIDEOGAP + audio position` (`:1286-1291`, `screens/controllers/UScreenSingController.pas:318`) |
| `#VOCALS`, `#INSTRUMENTAL` | 1.x: audio file references (SPEC-1 A.3) | same | read if the file exists (`:1268-1284`) |
| `#PREVIEWSTART` | **seconds**, decimal (SPEC-U §3.11) | **milliseconds** (SPEC-2 A.4) | float seconds (`:1371-1381`) |
| `#MEDLEYSTARTBEAT`, `#MEDLEYENDBEAT` | beats (SPEC-U §3.12) | renamed `#MEDLEYSTART`, `#MEDLEYEND`, in milliseconds (SPEC-2 A.5) | integer beats, ignored in relative mode (`:1383-1397`) |
| `#YEAR` | four digits (SPEC-U §3.13) | same | integer (`:1311-1316`) |
| `#GENRE`, `#LANGUAGE`, `#EDITION`, `#CREATOR` | free text in unversioned; comma-separated lists in 1.x (SPEC-1 A.8-A.12) | same as 1.x | read; repeated headers are joined with commas (`:1012-1030`, `:1293-1303`) |
| `#TAGS` | 1.x: comma-separated keywords (SPEC-1 A.11) | same | read only when version is 1.0.0 or higher (`:1305-1309`) |
| `#PROVIDEDBY` | 1.x: source URL (SPEC-1 A.13) | same | not parsed, kept as a custom tag |
| `#COMMENT` | free text, no semantics (SPEC-U §3.20) | same | kept as a custom tag |
| `#AUDIOURL`, `#VIDEOURL`, `#COVERURL`, `#BACKGROUNDURL` | 1.x: URLs to locate missing files (SPEC-1 A.15) | same | kept as custom tags |
| `#RENDITION` | 1.x, added 2025-04-20: which recording, e.g. "live", "radio edit" (SPEC-1 A.16) | same | kept as a custom tag |

### Deprecated or implementation-specific

| Tag | Meaning | Source |
| --- | --- | --- |
| `#ENCODING` | unversioned only: `UTF-8`, `CP1252` or `CP1250`; discouraged. USDX ignores it from 1.0.0 on | SPEC-U §3.21; USDX `base/USong.pas:1141-1159` |
| `#RELATIVE` | unversioned only: `yes` enables relative mode (section 5). USDX rejects a 1.x file that carries it | SPEC-U §3.22; USDX `:1354-1369` |
| `#DUETSINGERP1`, `#DUETSINGERP2` | unversioned aliases of `#P1`, `#P2`; `#P1`/`#P2` win | SPEC-U §3.18; USDX `:1407-1449` |
| `#RESOLUTION` | editor grid only; USDX ignores it | WEB "Deprecated"; USDX `:1332-1337` |
| `#NOTESGAP` | purpose unknown; USDX stores it for unversioned files and ignores it from 1.0.0 | WEB "Deprecated"; USDX `:1339-1352` |
| `#CALCMEDLEY` | `off` disables USDX's automatic medley detection | WEB; USDX `:1399-1405` |
| `#AUTHOR`, `#PREVIEW`, `#ALBUM`, `#SOURCE`, `#YOUTUBE`, `#LENGTH`, `#FIXER` | found in the wild, called duplicates or unnecessary; no defined semantics | WEB "More duplicates"; SPEC-1 A.12 note |
| `#APPNAME-KEY` | application-specific headers should carry an app prefix and a hyphen; standard headers never contain a hyphen | SPEC-1 §3.1 |

Unknown tags: USDX keeps every unparsed header, and header lines without a colon, as "custom tags" and writes them back on save (`base/USong.pas:1072-1084`, `:1451-1456`; `base/UFiles.pas:107-120`, `:182`).

## 4. Body: notes, phrases, voices

Note line: `type start-beat duration pitch text` (SPEC-1 §4.1).

| Type | Name | Scoring | Source |
| --- | --- | --- | --- |
| `:` | regular | pitch is scored; octave may be ignored | SPEC-1 §4.1.1 |
| `*` | golden | as regular, more points | SPEC-1 §4.1.2 |
| `F` | freestyle | never scores | SPEC-1 §4.1.5 |
| `R` | rap | timing only, pitch must be ignored | SPEC-1 §4.1.3 |
| `G` | golden rap | as rap, more points | SPEC-1 §4.1.4 |

- USDX score weights per beat: freestyle 0, regular 1, golden 2, rap 1, golden rap 2 (`base/UMusic.pas:50`, `:82`).
- Unknown note types: an implementation may replace them with freestyle and must not invent semantics (SPEC-1 §4.1, clarified 2025-05-20). USDX silently skips such lines (`base/USong.pas:781-844`, no `else` branch).
- Start beat and duration are non-negative integers in beats, relative to `#GAP`. Pitch is a signed integer of half-steps from C4, so 0 is MIDI 60 (SPEC-1 §4.1; WEB "Notes").
- Text is everything after the single separator following the pitch. Leading and trailing spaces are significant: they carry the word boundaries. A space may sit at the end of one syllable or the start of the next with the same meaning (SPEC-1 §4.1, clarified 2025-04-22). USDX does not trim the text (`base/USong.pas:595-609`).
- End of phrase: `- start-beat` (SPEC-U §4.2). In the 2.0.0 draft the beat becomes optional (SPEC-2 §4.2). Two markers must not follow each other; implementations may ignore the repeat (SPEC-1 §4.2).
- Notes should not overlap and should be in ascending order per voice (SPEC-1 §4, §4.1); the 2.0.0 draft makes the ordering mandatory (SPEC-2 §4).
- Variable BPM lines (`B ...`) are not in any spec. USDX logs a warning and ignores them (`base/USong.pas:840-844`).

### Duets

- A voice change is a line `P` plus a digit. All following notes and phrase markers belong to that voice. It does not end a phrase (SPEC-1 §4.3).
- Unversioned: only `P1` and `P2`, and a duet body must begin with a voice change (SPEC-U §4.3). 1.x and 2.0.0: `P1`..`P9`; a body with no leading voice change is implicitly `P1`; numbers carry no meaning beyond order and the link to `#Pn` (SPEC-1 §4.3).
- Each voice has its own, independent beat timeline; voices should not be interlaced (SPEC-1 §4.3).
- USDX: a Song is a duet only if the first body line starts with `P`. A `P` line in a non-duet Song fails the load. Only `P1` and `P2` are accepted; any other number fails the load. `P 1` with a space is tolerated (`base/USong.pas:700-708`, `:738-779`).
- Not in current sources: the older `P3` "both voices" convention. USDX at the pinned commit rejects it. Whether libraries still contain such files is **unverified**.

## 5. Relative mode (unversioned only)

- Enabled by `#RELATIVE:yes`, case-insensitive (SPEC-U Appendix A).
- Phrase markers gain a second number: `- start-beat rel-offset`. Start beats of notes and markers are relative to a running offset `rel`; after each marker, `rel += rel-offset`. Each voice keeps its own `rel` (SPEC-U Appendix A).
- Implementations must not guess relative mode from the markers when the header is missing (SPEC-U Appendix A).
- Conflict: the spec says `rel` starts at the `#GAP` value. USDX starts it at 0 and applies `#GAP` separately in the beat-to-time conversion (`base/USong.pas:676-677`, `:827`, `:1682-1686`; `base/UNote.pas:269`). Follow USDX: `#GAP` is milliseconds and `rel` is beats.
- Removed in 1.0.0: USDX rejects a versioned file with `#RELATIVE` (`base/USong.pas:1363-1368`).
- USDX can write relative files, but never for duets (`base/UFiles.pas:155`, `:210-216`).

## 6. Text encodings

- Spec: UTF-8 only, no byte order mark; readers may tolerate a BOM (SPEC-U §2, SPEC-1 §2).
- In the wild: the spec itself documents `#ENCODING` values `UTF-8`, `CP1252`, `CP1250` for legacy files (SPEC-U §3.21). USDX's comments name CP1250 as "used by Ultrastar" and CP1252 as "used by UltraStar Deluxe < 1.1" (`base/UTextEncoding.pas:41-48`). USDB Syncer still offers UTF-8, UTF-8 with BOM and CP1252 as output encodings (SYNCER `settings.py:280-285`).
- USDX detection order (`base/USong.pas:1051-1055`, `:1141-1159`):
  1. UTF-8 BOM present: UTF-8, BOM stripped.
  2. Version 1.0.0 or higher: always UTF-8, `#ENCODING` ignored.
  3. Unversioned with `#ENCODING`: that encoding. Names are matched after removing dashes and upper-casing, so `UTF-8`, `utf8`, `CP1252`, `CP1250`, `LOCALE`, `AUTO` are recognised (`base/UTextEncoding.pas:217-233`).
  4. Otherwise "auto": each value is tested against the W3C UTF-8 validity pattern and decoded as UTF-8 if it matches, else as CP1252 (`encoding/Auto.inc:25-104`, `base/UTextEncoding.pas:252-253`). The default can be changed in the USDX config (`base/UIni.pas:1670`).
- Detection in USDX runs per string (each header value, each note text), not per file (`base/USong.pas:1645`, `:1165`), so a file with mixed encodings still loads.
- USDX writes in the Song's encoding and writes `#ENCODING` only for unversioned files with an explicit encoding (`base/UFiles.pas:124-138`).
- How common each encoding is in real libraries: **unverified**, no primary data found.

## 7. How USDX tolerates malformed files

Rejected (Song not listed or not loadable):

| Condition | Source |
| --- | --- |
| First line of the file is empty | `base/USong.pas:1041-1049` |
| File ends while still in the header | `:1076-1081`, `:1103-1108` |
| Missing `#TITLE`, `#ARTIST`, `#BPM`, or audio header | `:1463-1476` |
| Audio file named by `#MP3`/`#AUDIO` does not exist | `:991-1008` |
| `#BPM` unparsable or below 1 after scaling | `:1211-1230` |
| Invalid `#VERSION`, or version 2.0.0 and above | `:1118-1138` |
| `#RELATIVE` in a 1.x file | `:1363-1368` |
| No line starting with `:`, `*`, `F`, `R`, `G` or `P` | `:682-699` |
| `P` line in a non-duet, or a `P` number other than 1 or 2 | `:738-779` |
| A non-integer where a beat, duration or pitch is expected | `:539-553`, `:853-858` |
| An empty or whitespace-only line inside the body, before `E`: the type parser raises and the load aborts. This contradicts SPEC-1 §2.1 | `:497-537`, `:571-593`, `:734`, `:853-858` |
| A voice with no notes left after empty phrases are removed | `:862-878` |

Tolerated:

| Condition | What USDX does | Source |
| --- | --- | --- |
| The header ends at the first line not starting with `#`; later `#` lines are not headers | body scan starts over from the top and skips to the first note line | `:1066`, `:680-691` |
| Header line with no colon | kept as a custom tag | `:1072-1084` |
| Header with empty value | treated as absent | `:1092-1097` |
| Duplicate header | logs "only the last value will be used"; list headers are joined instead | `:969-986`, `:1012-1030` |
| Lower-case or padded keys and values | key upper-cased, both trimmed | `:1087-1088` |
| Decimal comma in `#BPM`, `#GAP`, `#START`, `#VIDEOGAP`, `#PREVIEWSTART` | converted to a point; unparsable becomes 0 | `:908-916` |
| Non-integer `#END`, `#YEAR`, medley beats | value dropped | `:1311-1330`, `:1383-1397` |
| Missing video file | logged, Song loads | `:1257-1266` |
| Missing cover or background file | not checked at load | `:1243-1255` |
| Zero-length note | converted to freestyle with a warning | `:798-807` |
| Unknown line type in the body, including `B` | skipped | `:781-844` |
| Phrase marker with no notes since the last one | logged (not for duets), empty phrase dropped | `:1652-1668`, `:648-668` |
| Missing final `E` | end of file ends the body | `:846-848` |
| Extra spaces or tabs between note fields | skipped; only one separator after the pitch is consumed | `:497-537` |
| Mismatched upper/lower case in a file reference | not tolerated: exact match only, so it fails on Linux | `:996` |

## 8. Folder and file naming

What the code requires:

- USDX scans each configured song path recursively and treats every `*.txt` file as a candidate Song, at any depth. Nothing is required of folder or file names (`base/USongs.pas:198-239`, `:390-421`, `:430-470`).
- Several `.txt` files in one folder are each loaded as a separate Song; a non-Song `.txt` (a readme, a licence) is simply rejected by the header checks (same code; section 7).
- The first folder level below the song path is USDX's "folder" category (`base/USong.pas:409-438`).
- Media is found only through the header file references, relative to the `.txt` (SPEC-1 §3.2). There is no fallback search for a cover or audio file by name in the Song loader (`base/USong.pas:1183-1284`).

What the community convention is:

- Folder and files named `Artist - Title`: WEB says the audio file "should have the same name as the folder" and uses `Artist - Title.mp3`. USDB Syncer's default path template is `:artist: - :title: / :artist: - :title:` (SYNCER `src/usdb_syncer/path_template.py:65`).
- Suffixes: cover `Artist - Title [CO].jpg`, background `[BG].jpg`, vocals `[VOC]`, instrumental `[INSTR]` (WEB, attribute sections).
- Cover: JPEG, 1:1, at most 1920 px (WEB "COVER").
- The owner's downloader writes a different, fixed layout: folder `Artist - Title` holding `song.txt`, `video.mp4`, `cover.jpg`, `metadata.json`, with `#MP3` and `#VIDEO` both pointing at `video.mp4` (OWNER `apps/api/src/routers/songs.ts:77-78`, `:115-141`).
- Other in-the-wild conventions (for example `[VIDEO]` or `[SC]` markers in names, `.sco` score files): **unverified**, not found in the sources read.

## 9. Media in libraries versus browser playback

### What appears in libraries

- USDX decodes audio and video through FFmpeg, so libraries built for it can contain almost any format (`media/UAudioDecoder_FFmpeg.pas`, `media/UVideo.pas`). The exact codec list depends on the FFmpeg build: **unverified**.
- Extensions the USDX editor offers: audio `.mp3 .flac .wav .ogg .m4a`; video `.avi .mov .divx .mkv .mpeg .mpg .mp4 .m2v .ts .webm .wmv` (`screens/UScreenEditSub.pas:5392-5394`).
- WEB: "All software support at least .mp3 (CBR), .wav and .ogg audio files"; video "such as MP4 or AVI".
- USDB Syncer, the main current library builder, downloads audio as M4A, MP3, Ogg or Opus and video as MP4 (AVC, VP9 or AV1) or WebM, with optional re-encode to H.264, H.265, VP9 or AV1 (SYNCER `settings.py:500-506`, `:613-621`, `:672-678`).
- The owner's downloader produces one `video.mp4` used as both audio and video. It runs `yt-dlp -S ext,res:1080` (OWNER `packages/youtube-api/src/lib/downloadYoutubeVideo.ts:36-49`). Which codecs end up inside that MP4 (H.264 or AV1, AAC or Opus) is **unverified**; it depends on what YouTube offers per video.
- `#MP3` pointing at a video container is therefore normal, and the audio header must be treated as "any media file with an audio track". WEB adds that USDX and Vocaluxe play the video's audio track when there is no audio file.
- Share of each format in real libraries: **unverified**, no primary data found.

### What browsers play natively

Targets from the map: Stage on Chromium (desktop), Phones on iPhone Safari and Android Chrome. Only the Stage plays Song media.

| Format | Chromium / Chrome | Safari | Source |
| --- | --- | --- | --- |
| MP3 | yes | yes | MDN-A "MP3"; CHROMIUM |
| AAC in MP4/M4A | Chrome yes; Chromium builds without proprietary codecs no | yes | MDN-A "AAC"; CHROMIUM |
| Vorbis in Ogg/WebM | yes | no | MDN-A "Vorbis" |
| Opus in Ogg/WebM | yes | limited (CAF container per MDN) | MDN-A "Opus" |
| FLAC | yes | yes (11+) | MDN-A "FLAC" |
| WAV (PCM) | yes | yes | MDN-C "WAVE"; CHROMIUM |
| H.264 in MP4 | Chrome yes; plain Chromium no | yes | MDN-V "AVC"; CHROMIUM |
| VP8, VP9 in WebM | yes | yes | MDN-V "VP8", "VP9" |
| AV1 in MP4/WebM | yes (70+) | only recent Apple hardware | MDN-V "AV1" |
| HEVC in MP4 | only with hardware support | yes (11+) | MDN-V "HEVC"; CHROMIUM |
| Theora in Ogg | removed (support ended at Chrome 121) | no | MDN-V "Theora" |
| MPEG-4 Part 2 (DivX, Xvid) | no | no | MDN-V "MP4V-ES" |
| MPEG-1, MPEG-2 video | no | yes | MDN-V "MPEG-1", "MPEG-2" |
| Containers | MP4/MOV, Ogg, WebM, WAV, Matroska, HLS | MP4, WebM, Ogg listed for all browsers | CHROMIUM "Container formats"; MDN-C index |
| AVI, WMV/ASF, FLV containers | not in Chromium's supported list | not in MDN's supported list | CHROMIUM; MDN-C index |

Consequences:

- Plays natively on a Chrome Stage: MP3, M4A/AAC, Ogg Vorbis, Opus, FLAC, WAV audio; MP4 with H.264, VP9 or AV1; WebM with VP8, VP9 or AV1; and MKV when the codecs inside are supported.
- Does not play: AVI, DivX/Xvid, MPEG-1/2, WMV, FLV, Theora. A library with older Songs will contain these (they are in the USDX editor's extension list), so each such Song needs server-side transcoding or must fall back to its background image.
- The container alone does not decide playability: an `.mp4` or `.mkv` can hold an unsupported codec. A reliable check needs the codec, either by probing on the server or by asking the browser (`canPlayType`, whose behaviour Chromium defines in `media/base/mime_util.cc` per CHROMIUM). Runtime behaviour was not tested: **unverified**.
- A Stage on a Chromium build without proprietary codecs (some Linux distributions) loses AAC and H.264, which would break the owner's own `video.mp4` downloads (CHROMIUM "Proprietary ... Limited to Google Chrome").

## 10. Writing `.txt` back

What USDX's own writer does, as the compatibility baseline (`base/UFiles.pas:84-239`):

- Keeps the Song's version and encoding. Writes `#VERSION` only for 1.0.0 and above; writes `#ENCODING` only for unversioned files with an explicit encoding.
- For 1.x writes both `#AUDIO` and `#MP3`; for unversioned only `#MP3`.
- Header order: version or encoding, title, artist, language, edition, genre, year, creator, tags, audio, instrumental, vocals, cover, background, video, videogap, notesgap, start, end, relative, previewstart, medley beats, `#BPM` (stored value divided by 4), `#GAP`, `#P1`/`#P2`, then all custom tags.
- Body: `P1`/`P2` lines for duets, one note per line with single spaces, `- beat` between phrases but none after the last, final `E`.
- It rewrites the whole file from its parsed model. Anything the model does not hold is lost: comments between notes, original header order, original line endings, and custom tags when they were not requested at load (`base/USong.pas:954-964`).

Spec rules for writers: UTF-8 without BOM, LF line endings, upper-case keys, ASCII spaces, file ends with `E` (SPEC-1 §2, §2.1, §3).

## Facts later decisions most depend on

1. **Units differ by generation.** In unversioned and 1.x files `#START`, `#VIDEOGAP`, `#PREVIEWSTART` are seconds and `#GAP`, `#END` are milliseconds; `#BPM` is a quarter of the real beat rate. The 2.0.0 draft moves everything to milliseconds and drops the quadrupling. A parser must branch on `#VERSION` major, and the Timing editor (`GAP`, `BPM`, video offset) must write the units of the file's own version.
2. **Write what was read.** To stay compatible with USDX, write unversioned or 1.x, never 2.0.0: USDX rejects 2.0.0. Preserve unknown headers and the original encoding or convert deliberately to UTF-8.
3. **Encoding needs detection.** BOM, then `#VERSION`, then `#ENCODING`, then UTF-8 validity with CP1252 fallback. CP1250 files without an `#ENCODING` header cannot be told from CP1252.
4. **Be more lenient than USDX on read, as strict as the spec on write.** USDX rejects empty body lines and case-mismatched file names; the spec allows the first, and Linux breaks the second. OpenStar runs on Linux in Docker, so case-insensitive lookup of file references is needed for libraries built on Windows.
5. **`#MP3`/`#AUDIO` may name a video file.** The owner's downloader always does this. Audio playback must work from an MP4.
6. **Duets are two voices in practice.** USDX supports only `P1`/`P2`; the spec allows up to nine. Relative mode exists only in unversioned files and keeps a separate offset per voice.
7. **Not every Song's media plays in the browser.** Modern downloads (MP4/H.264/AAC, WebM, MP3, Ogg, Opus) play on a Chrome Stage. Legacy AVI/DivX/MPEG/WMV video does not. The spec needs a decision: transcode on the server, or show the background image instead.
8. **Any `.txt` anywhere is a candidate Song.** There is no required folder layout; identification is by parsing, and media is found only through header references.

## Open or unverified

- Whether 1.2.0 is an official spec version or only a USDB Syncer convention.
- The final content of 2.0.0: the draft says it may change significantly.
- Frequency of each encoding, media format and legacy convention (`P3`, `[VIDEO]`-style names) in real libraries. Measuring the owner's actual `/songs` volume would settle this for v1.
- Codecs inside the owner's `video.mp4` files.
- Actual runtime behaviour of USDX and of browsers; everything here is from source and documentation.
