# A placeholder Library

The scan tests (`crates/server/tests/library_scan.rs`) copy this folder into a
temporary Library, then create every file listed in `media.list` there as an empty
file (media is never committed). Placeholder lyrics only.

| `.txt`                                      | What it covers                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Placeholder Artist - First Song/first.txt` | `#MP3` and `#COVER` in other case; `#BACKGROUND` missing (warning); a `.txt.orig` beside it |
| `Nested/Deeper/Second/second.txt`           | depth; 1.x `#AUDIO` through a folder in other case; `#VIDEO` missing (warning)              |
| `Two In One/solo.txt`, `duet.txt`           | two candidates in one folder                                                                |
| `Missing Audio/missing.txt`                 | audio not found (rejection)                                                                 |
| `No Audio/no-audio.txt`                     | no audio reference (rejection)                                                              |
| `Escapes/outside.txt`                       | a reference that leaves the Library: not found                                              |
| `Escapes/absolute.txt`                      | an absolute reference: not found                                                            |
| `readme.txt`                                | not a Song: rejected by the header rules                                                    |
