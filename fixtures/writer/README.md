# Writer golden pairs

Each folder is one case for the `.txt` writer: `input.txt` plus the operations
in `operations.json` must give `expected.txt`, byte for byte. Placeholder
lyrics only (see `../README.md`). `crates/server/tests/txt_writer.rs` runs
every folder and keeps an `insta` snapshot of the changed lines.

`operations.json` is a list applied in order. Line numbers are 1-based and
always name lines of `input.txt`:

| `op`            | Fields                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `setNoteStart`  | `line`, `start`                                                                                           |
| `setNoteLength` | `line`, `length`                                                                                          |
| `setNotePitch`  | `line`, `pitch`                                                                                           |
| `setNoteText`   | `line`, `text`                                                                                            |
| `insertNote`    | `after`, `kind` (`normal`, `golden`, `rap`, `goldenRap`, `freestyle`), `start`, `length`, `pitch`, `text` |
| `deleteNote`    | `line`                                                                                                    |
| `setGap`        | `seconds` (written as milliseconds)                                                                       |
| `setBpm`        | `beatsPerMinute`, the real beat rate (written as the rate ÷ 4)                                            |
| `setVideoGap`   | `seconds`                                                                                                 |
| `setLineEnd`    | `line`, `beat`                                                                                            |
