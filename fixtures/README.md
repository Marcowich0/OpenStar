# Fixtures

Test cases that are data, shared by every implementation that needs them. The
repository is public, so nothing copyrighted is committed here.

## Rules

1. **Data files only.** A test case lives here as a file (`.txt`, `.json`, a
   description of tones to generate), not as a literal inside one language's tests, so a
   second implementation (Rust and TypeScript, or the server rescoring a
   Performance) runs the same cases. Tests read these files; they do not copy
   them.
2. **Placeholder lyrics only.** No real Song text is ever committed. Every
   `.txt` fixture uses made-up lyrics (`la`, `Placeholder`, `one two three`).
3. **No real Song audio.** Audio and video are generated at test time (sine
   melodies, tones, noise, tiny media made with ffmpeg) into a directory that
   `.gitignore` excludes. **Generated media is never committed.**
4. **Openly licensed media only, with attribution.** The one exception to rule
   3 is openly licensed material (such as the Vocadito excerpts, CC BY 4.0). It
   lives in its own directory below `fixtures/` with an `ATTRIBUTION.md` that
   names the source, the authors, the licence and a link to it.
5. **Floors only ever rise.** A threshold set from the first passing run (for
   example detector accuracy on real singing, or how many Beats a singing run
   stays voiced) may be raised when the code gets better, never lowered to make
   a test pass. Lowering a floor is a spec change, not a test fix. The floors
   live as committed values beside their data, for example
   `readings/floors.json` for the Beat-value regression runs.

## The guard

`just check` runs `scripts/check-fixture-media.sh`. It fails when an audio or
video file (by extension or by content) under `fixtures/` would be committed and
no `ATTRIBUTION.md` sits in its directory or a parent directory below
`fixtures/`. An `ATTRIBUTION.md` directly in `fixtures/` covers nothing.
