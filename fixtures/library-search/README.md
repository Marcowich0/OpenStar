# Library for search and filters

A small Library for `crates/server/tests/library_search.rs` (`GET /api/songs`
with a `SongQuery`). Placeholder lyrics only. The media files named in
`media.list` are tiny placeholders generated at test time
(`openstar_test_harness::placeholder_media`: a short MP3, or a short H.264 MP4
for a video name), so they play natively and are never converted.

| Folder                     | What it covers                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Alpha Artist - Sunny Day` | Two languages on one line, `#GENRE` repeated (joined), year 1999, `#END` 180 s.                                                                          |
| `Beta Band - Night Song`   | A duet with a video, genre `rock` in lower case, two creators (`bob, Alice`), `#END` 240 s.                                                              |
| `Unicode/Strasse`          | Non-ASCII artist and title (`Straße` folds to `strasse`), language `english` in lower case, no `#END`, so its length is its placeholder audio's (0.3 s). |
| `Copy One`, `Copy Two`     | Two copies with the same USDB id (`metadata.json`): one identity, listed once. `#END` 120 s.                                                             |
| `Rejected`                 | Audio not found: rejected, so neither it nor its values (French, Metal, 1970) appear.                                                                    |
