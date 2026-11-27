# Capture clock cases

Scripts for one sender session of the capture clock (#106, rules in v1 spec #50,
"Timestamping" and "Clock sync with the Stage"): the frame-to-clock mapping, the
clock sync estimator, the ping schedule and the session that combines them. No
audio and no network: every time is an input. The native build runs them in
`crates/capture-clock/tests/fixtures.rs`, the WASM build through the TypeScript
wrapper in `web/src/pitch/clock/senderSession.test.ts`.

## Format

| Field                 | Meaning                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`         | What the file covers.                                                                                                                                                                 |
| `session`             | `remote` (a Phone or a Mic bridge, synced by pings) or `local` (the Stage browser's own Local mics: offset 0, no pings).                                                              |
| `trueTimeSpreadMaxMs` | Optional. Over the readings that carry a true time, `max − min` of (stamp − true time) must not exceed it: the stamps follow the true capture time up to a constant lag, within this. |
| `steps`               | Run in order on one session; each is an array, first the step's name.                                                                                                                 |

Times are ms on the sender's own clock unless they say otherwise. Expected values
are written to 6 decimals and compared within 1e-5 ms; `null` means "none".

| Step                                                | Does                                                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `["start", nowMs, sampleRate]`                      | Capture starts (again) on a new stream at `sampleRate` Hz: the mapping starts afresh, pings go fast.                                                                          |
| `["stop"]`                                          | Capture stops: no more pings.                                                                                                                                                 |
| `["restartSync", nowMs]`                            | The connection to the Stage was made again: samples discarded, pings fast.                                                                                                    |
| `["ping", nowMs, expectedT0]`                       | Polls the schedule at `nowMs`: the ping's `t0` (it is then sent), or `null` when none is due.                                                                                 |
| `["nextPing", expected]`                            | When the next ping is due.                                                                                                                                                    |
| `["pong", t0, t1, ts, epoch]`                       | A pong for the ping sent at `t0`, handled at `t1`; `ts` is the Stage's time (its clock), `epoch` its `performance.timeOrigin`.                                                |
| `["offset", expected]`                              | Stage clock − sender clock.                                                                                                                                                   |
| `["reading", endFrame, handledMs, expected, true?]` | A worklet reading ending at `endFrame` (at the last `start`'s rate) handled at `handledMs`: its capture time on the Stage's clock, or `null` when dropped. `true`: see above. |

## Files

`local-mics.json`, `ping-schedule.json` and `stale-pong.json` are worked by hand. The
others are made by a generator, `crates/capture-clock/tests/support/generate.rs`, from
a model of the device (audio clock rate, main-thread delay, bursts, network delays, a
Stage clock with an offset and drift) and a naive reference of the rules;
`generated_files_are_current` fails when they differ. Regenerate with
`OPENSTAR_UPDATE_CLOCK_FIXTURES=1 cargo test -p openstar-capture-clock --test fixtures`.
Each description says what the case shows and where its limit comes from.

## Choices the spec left open

- A frame counter that goes backwards or a new sample rate also resets the mapping (the
  old spreads cannot belong to that stream); a `start` always does.
- A reading handled before an offset exists is dropped at once, never held back; it
  still teaches the mapping. One handled after the first pong is stamped, even if it was
  captured a little before.
- Of equal round trips, the newest sample wins.
- A pong of another epoch that answers a ping sent before the one that started the
  current epoch is stale (the old Stage page answered it before it went) and ignored.
  Any other pong of another epoch discards every sample and pings fast from its `t1`.
- A ping sent less than 5 s after the fast phase began is followed 200 ms later, so the
  first slow interval starts at the first ping sent after the 5 s.
- Starting capture again keeps the offset (the Stage's clock has not changed); a
  reconnect (`restartSync`) discards it.
- What the plain minimum leaves: with an audio clock running slow by _d_, the stamps lag
  the true window centre by about _d_ × 1 s (the envelope's length), a constant that
  Calibration absorbs into the Mic delay. That lag moves by about _d_ times the length
  of a hold of the oldest readings in the envelope, so `varying-delay` (3 %) and
  `bursts` (5 %) allow 12–14 ms against handling delays that spread over 80–185 ms.
