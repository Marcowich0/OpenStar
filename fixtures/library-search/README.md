# Library for search and filters

A small Library for `crates/server/tests/library_search.rs` (`GET /api/songs`
with a `SongQuery`). Placeholder lyrics only. The media files named in
`media.list` are created empty at test time; an empty `#VIDEO` file cannot be
probed, so it counts as a video (its conversion decides).

| Folder                     | What it covers                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Alpha Artist - Sunny Day` | Two languages on one line, `#GENRE` repeated (joined), year 1999, `#END` 180 s.                                                          |
| `Beta Band - Night Song`   | A duet with a video, genre `rock` in lower case, two creators (`bob, Alice`), `#END` 240 s.                                              |
| `Unicode/Strasse`          | Non-ASCII artist and title (`Straße` folds to `strasse`), language `english` in lower case, no `#END` and no probed audio, so no length. |
| `Copy One`, `Copy Two`     | Two copies with the same USDB id (`metadata.json`): one identity, listed once. `#END` 120 s.                                             |
| `Rejected`                 | Audio not found: rejected, so neither it nor its values (French, Metal, 1970) appear.                                                    |
