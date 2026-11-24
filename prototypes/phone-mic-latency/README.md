# PROTOTYPE: Phone mic end-to-end latency

Throwaway. Lives only on branch `prototype/phone-mic-latency`, never merged.
Answers the wayfinder ticket *Phone mic end-to-end latency*
(https://github.com/Marcowich0/OpenStar/issues/10): do the chosen pitch detection
(McLeod Pitch Method, `pitchy`, 2048-sample window, in an `AudioWorklet` on the Phone)
and transport (timestamped Pitch readings over one WebSocket through the server, clock
matched to the Stage) work on real phones?

## Run

```sh
cd relay && BIND=0.0.0.0 cargo run --release   # :8787; BIND=0.0.0.0 lets a LAN Stage use plain HTTP
tailscale serve --bg --https=8443 http://127.0.0.1:8787   # trusted HTTPS for phones
```

Rebuild the worklet bundle after editing `worklet-src/`: `cd worklet-src && npm i && npm run build`.

- Stage: `https://<host>:8443/stage.html` on the desktop (Chromium), click **Start Stage audio**.
- Phone: `https://<host>:8443/phone.html`, tap **Start mic**, keep the screen on.

## What it measures

| Number | Meaning |
| --- | --- |
| Transport delay | Stage arrival time minus the reading's window end, both on the Stage clock. Wi-Fi + relay + Phone main-thread slack + clock-sync error. |
| Gaps over 50/100 ms | Inter-arrival gaps on the Stage: what makes the drawn trace stutter. The trigger for the WebRTC data channel upgrade. |
| Lost / reordered | Sequence-number gaps and inversions. |
| Clock offset, RTT, drift | NTP-style sync, Phone to Stage through the relay; best-RTT sample of the last 30. |
| MPM bench | Main-thread cost of one 2048-sample `findPitch` on the Phone's CPU (the AudioWorklet scope has no `performance` timer in Chromium). |
| Beep test: loop | Reading's capture time (window centre) minus when the Stage says the beep left its output. Equals Stage output delay + air (≈3 ms/m) + Phone input delay + detector bias: the per-mic calibration constant. Its spread shows whether one constant is enough. |
| Beep test: seen | When that first detecting reading reached the Stage: the lag a singer sees. |
| Melody: bleed | Readings that would score (voiced at a clarity threshold and within ±150 cents, octave folded) while nobody sings: backing-track bleed. |
| Melody: sing along | The same with someone singing, to compare against bleed. |

**Save results** writes a JSON file with every reading into `results/`.

## Layout

- `relay/`: Rust (axum) relay and static server, the backend stack the map chose. Turns `TCP_NODELAY` on.
- `web/phone.html`, `web/stage.html`: the two pages.
- `worklet-src/`: the AudioWorklet source, bundled with `pitchy` into `web/pitch-worklet.js`.
- `results/`: saved runs.
