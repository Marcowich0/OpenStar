# OpenStar Mic bridge

The native app that reads every channel of an audio interface and joins the
Stage through the server (v1 spec #51). See the crate docs (`src/lib.rs`).

## Building

Real capture links the system's PipeWire library, so building needs its
development files and libclang (for the bindings), for example on Debian or
Ubuntu: `libpipewire-0.3-dev libclang-dev pkg-config`, PipeWire 0.3.65 or
newer: no `pipewire-rs` release compiles against older headers (Ubuntu
22.04's 0.3.48). The released binary is built on Debian 12 (the Dockerfile's
`bridge` stage) and calls only functions 0.3.48 has, so it still runs on
Ubuntu 22.04. The binary needs
`libpipewire-0.3.so.0` at run time, as every PipeWire desktop has, and links
nothing else beyond glibc (`tests/capture.rs` checks it); it never links
`libpulse`.

## How it finds interfaces

At start the window reads the cards and sources of the sound server over
the PulseAudio protocol (`src/pulse.rs`, read-only, pure Rust; PipeWire
answers through `pipewire-pulse`). `src/discovery.rs` offers each card in
the **Pro Audio** profile through its `….pro-input-N` source, keyed on the
card's `device.name` (serial-less twins: plus `@<USB port>`).
`src/capture.rs` opens each one as one PipeWire stream with every channel,
32-bit float, `AUX0…AUXn`, `stream.dont-remix`. Cards in other profiles
are skipped (#206 shows them with Switch to Pro Audio). The list is read
once at start: an interface plugged in later needs a restart.

## Manual check of real capture

Not run in CI (there is no sound server there); it is item 23 of
`docs/release-checklist.md`, on Ubuntu 22.04 as well. On a desktop with PipeWire
and an interface in Pro Audio (for example a Scarlett 4i4 4th Gen):

1. `pactl list cards short` shows the card; `pactl set-card-profile <card> pro-audio`.
2. Start the bridge from the app menu (or `openstar-mic-bridge`), approve it
   on the Stage's Mics screen.
3. **Passes:** the window lists the interface with one row per channel
   (Scarlett: Input 1–4, then Loopback 1–2); with the Mics screen open,
   every row's meter moves when its input hears sound, and only that row's.
4. Switch the card to another profile and back, restart the bridge:
   **passes** if every Local mic keeps its name and switch on the Mics screen.
