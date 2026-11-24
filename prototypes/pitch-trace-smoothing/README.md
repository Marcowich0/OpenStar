# PROTOTYPE: Smoothing the Phone pitch trace

Throwaway. Lives only on branch `prototype/pitch-trace-smoothing`, never merged.
Answers the wayfinder ticket *Smoothing the Phone pitch trace*
(https://github.com/Marcowich0/OpenStar/issues/29): how should the Stage draw a Phone's
pitch trace when the Wi-Fi holds readings back for 50–100 ms (worst about 270 ms),
2–5 times a second, then delivers 5–6 at once?

## Part 1: how the trace is drawn (`trace.html`)

One page with five ways of drawing a Phone lane, side by side or one at a time
(`?variant=all|A|B|C|D|E`, ← → or the bar at the bottom). Every lane gets the same
stream: a simulated singer on an invented Song, delivered with the **real per-reading Wi-Fi
lateness** recorded in the Phone mic latency runs (`wifi-holds.js`, from branch
`prototype/phone-mic-latency`), plus the measured ~100 ms Phone loop delay.

| | Variant | Trace end | Guesses? |
| --- | --- | --- | --- |
| A | On arrival (today) | last reading that has arrived, ~160 ms behind the playhead, stutters | no |
| B | Hold to the playhead | always at the playhead; flat at the last pitch past the last real reading | always, 130–400 ms |
| C | Hold to the usual delay | steady at the Phone's usual delay (low percentile of recent readings) | only during holds |
| D | Fixed delay | fixed D behind the playhead (default 300 ms), real readings only | never; stalls if a hold is longer than D |
| E | Adaptive delay + hold | delay follows the p95 of the last 3 s, flat hold bridges anything later | only past the p95 |

Each lane shows: **behind** (trace end behind the playhead), **guess** (flat guess drawn now),
**jumps**/s, **stalls**/s and **snaps**/s (guesses redrawn by over half a semitone).
The top strip shows when each reading reached the Stage, aligned with the lanes.

Keys: space pause, `s` speed (1×, 0.5×, 0.25×), `w` Wi-Fi (run 22, run 20, holds ×2, no holds),
`[` `]` change D, `g` mark guesses, `n` another stretch of Wi-Fi, `i` help, `h` hide bar.
URL: `&t=<ms>&paused=1` jumps to a moment.

## Part 2: WebSocket vs WebRTC data channel A/B (`ab/`)

The Phone opens its mic as decided (echo cancellation and noise suppression on, auto gain
off) and on every 512-sample audio frame sends one reading-sized message **twice**: over the
WebSocket through the relay, and over an unordered, no-retransmit WebRTC data channel
straight to the Stage (the relay passes the signalling). The Stage compares when the two
copies of each reading arrive:

- held on both at once → the radio holds them; a data channel would not help;
- held on the WebSocket only, the data channel copy on time → TCP holds them; it would.

```sh
cd ab/relay && BIND=0.0.0.0 cargo run --release   # :8787, also serves trace.html
```

- Stage: `http://<host>:8787/stage.html` in Chromium on the desktop. Click **Allow mic** once
  so WebRTC offers the desktop's LAN address instead of an mDNS name.
- Phone: `http://<host>:8787/phone.html` (Android Chrome with the insecure-origin flag for that
  address, as in the latency runs; or HTTPS via `tailscale serve --bg --https=8443 http://127.0.0.1:8787`).
  Tap **Start**, keep the screen on, wait a few minutes, then **Save results** on the Stage
  (written to `ab/results/`).
