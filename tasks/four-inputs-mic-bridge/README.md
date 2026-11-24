# Four inputs through the mic bridge: hardware check

A throwaway script for the wayfinder ticket
[Four inputs through the mic bridge](https://github.com/Marcowich0/OpenStar/issues/38).
This branch is never merged.

The [Local mic mapping](https://github.com/Marcowich0/OpenStar/issues/33) decision was made
using virtual PipeWire sources only. This script checks it on real hardware: it records
every input of the interface as **one** native PipeWire stream (`pw-record`, the same
approach the Mic bridge will take) and measures:

1. which PipeWire profile is active, and the channel count and positions of every input profile;
2. whether each input arrives alone on its own channel (one input fed at a time);
3. SM58 levels: singing, bleed from a Song at party volume, singing over the Song, and
   8 calibration-style tones, compared with the −30 dBFS fallback gate and a
   "bleed p95 + 6 dB" gate;
4. 60 s with every input running in the one stream, looking for dropouts or channels
   that go silent;
5. the browser path: a local page opens the device in Chromium with processing off and
   2 channels, and checks which input reaches which channel.

## Run it on the Stage PC

```sh
curl -LO https://raw.githubusercontent.com/Marcowich0/OpenStar/task/four-inputs-mic-bridge/tasks/four-inputs-mic-bridge/mic_test.py
python3 mic_test.py
```

It needs Python 3.9+ and the PipeWire tools (`pw-dump`, `pw-record`, `pw-play`; `pactl` if
present). It installs nothing and sends nothing anywhere. It writes
`~/openstar-mic-test-<date>/` with `report.md` (send this back), `results.json` and short
WAV files. `--short` does a quick dry run with short recordings.

**You need:** the interface, one or two SM58s with XLR cables, a line source and cable
for inputs 3–4 (a phone or laptop headphone output, or the PC playing the included test
signal through one of its outputs), speakers, and a song to play. It takes about 15 minutes.

**Hints for a Focusrite Scarlett 4i4:** a 3rd-gen unit starts in "MSD mode" (it shows up as
a USB drive) with reduced features; turn it off by holding the 48V button while plugging
it in. If inputs land on the wrong channels, look at the routing in `alsa-scarlett-gui`.
If you send a PC output back into the interface, turn Direct Monitor off first.

Checked in Docker against virtual 4-channel PipeWire sources (PipeWire 1.6.2, Chromium 159)
with the image from `prototype/local-mic-channels`. That run only proves the script works.
