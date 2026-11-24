# Timing editor prototype (throwaway, never merged)

HITL prototype for the wayfinder ticket **Timing editor interaction** (Marcowich0/OpenStar#20):
how does a user fix a misaligned Song, and which interaction makes the common case take seconds?

Run from the repo root:

```sh
node prototypes/timing-editor/serve.js      # http://localhost:8765/
```

Put a Song folder (its `.txt` plus media) under `prototypes/timing-editor/songs/<folder>/` (git-ignored)
and open `/?song=songs/<folder>/`, or drop a Song folder onto the page. The default is
`songs/vincent/` (Don McLean - Vincent from the owner's Library, not committed).

Three interactions, switched with `?variant=` or the bottom bar (← →):

- **A · Grab and drag**: drag the notes onto the heard pitch; pin a line and drag elsewhere to stretch (GAP + BPM); select lines to shift or stretch them; Alt-drag single notes.
- **B · Tap along**: tap Space on each syllable as you hear it; one place fixes GAP, a second place far away fixes BPM too.
- **C · Auto-fit**: the editor matches the notes to an offline pitch track of the audio and proposes GAP + BPM, then lists lines that still look off.

Shared by all: playback with a click on each note (optionally humming the notes), loop a line, speed 100/75/50 %,
`,` `.` nudge GAP, `[` `]` tempo around the playhead, undo/redo, and a preview of exactly which lines of the `.txt` would change.

Files: `timing.js` is the pure model (parse, edits, fit, minimal write-back) and the part worth lifting;
`pitch-worker.js` is the YIN pitch track; `index.html` is the throwaway shell; `serve.js` is a static server with Range support so the video can seek.
