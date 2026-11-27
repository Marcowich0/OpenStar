# Pitch track frames

`frames.json` pins the byte layout of a Pitch track download
(`GET /api/songs/{id}/pitch-track`) and of the frames in the cache file
`/appdata/cache/pitch/<song id>.bin`: one frame every 10 ms, three
little-endian `f32` values each (pitch in Hz with 0 for unvoiced, clarity,
RMS envelope). The Rust writer (`crates/server/src/library/pitch_track.rs`)
must write `bytes` from `frames`; the TypeScript reader
(`web/src/fit/pitchTrackFile.ts`) must read `bytes` back into `frames`.
The hex was computed independently (Python `struct.pack('<3f', …)`).
