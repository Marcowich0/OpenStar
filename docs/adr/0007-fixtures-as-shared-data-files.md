# Test cases are shared data files under `fixtures/`

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Recorded in [v1 spec: Testing, CI and release checklist](https://github.com/Marcowich0/OpenStar/issues/58).

Each pure core (the `.txt` parser and writer, the detector, the capture clock, the scorer, Calibration, the fit module) has one implementation and is pinned by test cases kept as data files under a top-level `fixtures/`, not as literals inside one language's tests. The spec's reason: a second implementation, such as rescoring on the server, can run the same cases without porting test literals. Tests read the files; they don't copy them. The detector's and the capture clock's cases, for example, are read both by their Rust tests and by the TypeScript tests of the worklet and the sender session.

## Consequences

- The repository is public, so fixtures use placeholder lyrics only, never real Song audio (audio and video are generated at test time and never committed), and openly licensed media only beside an `ATTRIBUTION.md` (the Vocadito excerpts). `just fixtures-check` runs `scripts/check-fixture-media.sh` to enforce the media rule.
- Floors only ever rise. A threshold set from the first passing run may be raised, never lowered to make a test pass; lowering one is a spec change.

The rules in full are in [`fixtures/README.md`](../../fixtures/README.md).

## Where it shows up

- `fixtures/` (for example `readings/floors.json`, `vocadito/`, `library/`), `scripts/check-fixture-media.sh`.
- `crates/test-harness` (installs `fixtures/library/` with generated audio, writes the fake mic WAVs of `fixtures/mic/`).
