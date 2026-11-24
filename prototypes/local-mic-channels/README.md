# Prototype: browser capture from a 4-channel PipeWire source

Throwaway measurement for wayfinder ticket #33 ("Local mic mapping"). The Stage is a Linux
PC with PipeWire, and the owner's interface is a 4-input Behringer UMC404HD. The question:
what does a browser on Linux actually get from a 4-channel PipeWire source, and are
PipeWire remap sources a working way to give each mic its own device?

Everything runs in Docker, with nothing installed on the host. **All sources here are
virtual**, so read the caveats below before you trust a result for real hardware.

## Run it

```sh
docker build -t openstar-mic-proto prototypes/local-mic-channels
mkdir -p out && chmod 777 out
docker run --rm --shm-size=1g -v "$PWD/out:/work/out" openstar-mic-proto            # full run, ~4 min
docker run --rm --shm-size=1g -v "$PWD/out:/work/out" -e FORCE_QUANTUM=256 \
  -e BROWSERS=chromium,firefox -e RESULTS_NAME=results-fq256 openstar-mic-proto      # quantum experiment
docker run --rm openstar-mic-proto /work/run.sh ./control.sh                          # browser-free control
```

Environment options: `BROWSERS` (`chromium,chromium-headless-shell,firefox`),
`FORCE_QUANTUM` (sets `clock.force-quantum`), `PW_PULSE_NO_CHANNELMIX=1` (sets
`stream.properties = { channelmix.disable = true }` in pipewire-pulse) and `RESULTS_NAME`.

Files:

| File | Purpose |
|---|---|
| `Dockerfile` | `mcr.microsoft.com/playwright:v1.65.1-resolute` plus pipewire, pipewire-pulse, wireplumber and sox |
| `run.sh` | Starts dbus-run-session, pipewire, wireplumber, pipewire-pulse, the test sources and Xvfb, then `node measure.mjs` |
| `setup-audio.sh` | Creates the virtual sources (see below) |
| `measure.mjs`, `page.html` | Playwright measurement: getUserMedia, then Web Audio splitter and an analyser per channel |
| `pa_multi.py`, `control.sh` | Browser-free control: one libpulse client recording 4 sources at once |
| `results/` | Raw JSON and logs from the runs below |

## Test setup

- `mic4_aux`: a 4-channel `Audio/Source/Virtual` (null-sink) with positions **AUX0..AUX3**,
  like a UMC404HD in the "Pro Audio" profile. A `pw-cat` stream fed from sox plays
  220 / 330 / 440 / 550 Hz, one tone per channel, linked port by port with `pw-link`.
  WirePlumber does not auto-link a playback stream into an `Audio/Source/Virtual`, and
  `--target` silently lands on the default sink.
- `mic4_quad`: the same source with **FL FR RL RR** positions, like the "Analog Surround
  4.0" profile.
- `mic4_aiff`: `module-remap-source` of `mic4_aux` relabelled **FL FC FR RC**. That is the
  PulseAudio default 4-channel map, which Firefox requests (see results).
- `ind1..ind4`: 4 independent mono virtual sources (220/330/440/550 Hz). This is the
  control. Each one drives its own graph.
- Remaps for step 4, loaded at run time:
  `pactl load-module module-remap-source master=mic4_aux master_channel_map=auxN channel_map=mono source_name=mic_chN`,
  and two stereo ones, `aux0,aux1` and `aux2,aux3` mapped to `front-left,front-right`.
- Chromium was started with `--use-fake-ui-for-media-stream`, **not** the fake device
  flag. `pactl list source-outputs` confirms that every capture is a real "Chromium input"
  PulseAudio stream on the intended source. Firefox was started with
  `media.navigator.permission.disabled=true` and `media.navigator.streams.fake=false`.
  Both browsers ran headed under Xvfb. The Chromium headless shell behaves the same as
  headed Chromium (it also uses PulseAudio).
- Per channel, a tone counts as present when it is above -70 dBFS and within 30 dB of the
  loudest test tone on that channel (AnalyserNode, fftSize 16384). `rms -200` means
  exact digital silence at probe time.

## Versions

| Component | Version |
|---|---|
| Chromium (Playwright build chromium-1255) | 159.0.8154.6 |
| Firefox (Playwright build firefox-1572) | 159.0 |
| Playwright | 1.65.1 |
| PipeWire / pipewire-pulse | 1.6.2 (Ubuntu 1.6.2-1ubuntu1.3) |
| WirePlumber | 0.5.13 |
| libpulse (client) | 17.0 |
| Base image | Ubuntu 26.04.1 (`mcr.microsoft.com/playwright:v1.65.1-resolute`) |
| Docker / host kernel | 29.1.3 / 7.0.0-43-generic (VM, no RT scheduling) |

## Results

### 1–3: one 4-channel source, one getUserMedia

`getSettings().channelCount` is the value the browser reports. "Delivered" is what reaches
Web Audio: one entry per ChannelSplitter output (1..4), showing which test tone(s) arrived.

| Browser | Source | Constraints | getCapabilities().channelCount | settings.channelCount | PulseAudio stream it opens | Delivered (ch1 / ch2 / ch3 / ch4) |
|---|---|---|---|---|---|---|
| Chromium | AUX0..3 | raw\*, `channelCount ideal 4` | {1..2} (also on InputDeviceInfo) | 2 | s16le **2ch FL,FR** | 220 / 330 / – / – |
| Chromium | AUX0..3 | raw, `channelCount exact 4` | – | **OverconstrainedError** | – | – |
| Chromium | AUX0..3 | defaults (processing on) | {1..2} | 1 | s16le 2ch FL,FR | 220+330 / 220+330 (mono downmix, duplicated) |
| Chromium | AUX0..3 | defaults + `ideal 4` | {1..2} | 2 | s16le 2ch | 220+330 / 220+330 |
| Chromium | FL FR RL RR | raw, `ideal 4` | {1..2} | 2 | s16le 2ch FL,FR | 220+440 / 330+550 (PipeWire downmix of the rears) |
| Chromium | FL FR RL RR | raw, `exact 4` | – | **OverconstrainedError** | – | – |
| Chromium | FL FR RL RR | defaults | {1..2} | 1 | s16le 2ch | all four tones on both channels |
| Chromium | FL FC FR RC | raw, `ideal 4` | {1..2} | 2 | s16le 2ch | 220+330+550 / 330+440+550 |
| Firefox | AUX0..3 | raw, `ideal 4` or `exact 4` or none | {1..4} (no InputDeviceInfo.getCapabilities) | **4** | float32 **4ch FL,FC,FR,RC** | 220 / – / 330 / – (**AUX2/AUX3 lost**) |
| Firefox | AUX0..3 | defaults (± `ideal 4`) | {1..4} | 4 (wrong) | float32 4ch | Web Audio sees **1** channel: 220+330 |
| Firefox | FL FR RL RR | raw, `ideal 4` / `exact 4` | {1..4} | 4 | float32 4ch FL,FC,FR,RC | 220 / – / 330 / 440+550 |
| Firefox | FL FR RL RR | defaults | {1..4} | 4 (wrong) | float32 4ch | 1 channel: all four tones |
| **Firefox** | **FL FC FR RC** (`mic4_aiff` remap) | raw, `ideal 4` | {1..4} | 4 | float32 4ch FL,FC,FR,RC | **220 / 330 / 440 / 550** (all 4 discrete) |

\* raw = `echoCancellation:false, noiseSuppression:false, autoGainControl:false`.

- **Chromium never opens more than 2 channels.** It always asks PulseAudio for
  `2ch FL,FR`, and PipeWire's channel mixer decides what lands there. With AUX positions
  you get AUX0/AUX1 and AUX2/AUX3 are unreachable. With surround positions you get a
  downmix. `exact:4` fails. This confirms the "max 2 channels" claim, at least for
  Chromium on PulseAudio/PipeWire.
- **Firefox opens 4 channels**, but always with the PulseAudio default 4-channel map
  FL,FC,FR,RC. PipeWire then remixes by position, so with the UMC's AUX positions only
  2 inputs survive. It works only when the source's positions match FL,FC,FR,RC exactly:
  a remap source with that map gave 4 clean discrete channels.
- With processing on, Chromium reports `channelCount` 1 (or 2 when `ideal 4` is given)
  and delivers a mono downmix. Firefox *reports* 4 but delivers 1 downmixed channel.
  Neither keeps channels separate once processing is on.

### 4: remap sources, opened concurrently in one page

| Config | Chromium | Firefox |
|---|---|---|
| Control: 4 independent mono virtual sources, raw | 4/4 correct tones, clean | 4/4 clean |
| 4 mono remaps, raw, held 20 s | **ch2 and ch3 silent** (rms -200), ch4 partial | ch3 silent, the rest clean |
| same, 3 more rounds (3 s each) | 1–3 of 4 silent in every round | ch3 (sometimes ch4) silent in every round |
| 4 mono remaps, defaults (processing on) | 2 of 4 silent | 1 of 4 silent |
| 2 stereo remaps (AUX0/1 and AUX2/3 as FL/FR), raw, 20 s | 2nd stream partly or fully silent (flaky across runs) | 2/2 clean, correct L/R tones |
| **with `clock.force-quantum 256`**: 4 mono remaps raw, 20 s plus 3 rounds | **4/4 clean in all rounds** | **4/4 clean in all rounds** |
| with `clock.force-quantum 256`: 2 stereo remaps | 2/2 clean | 2/2 clean |
| with `clock.force-quantum 256`: 4 mono remaps, defaults | all live, but **cross-talk**: Remap-ch3 also carries 220, Remap-ch4 carries all four tones, levels -25..-34 dB (AGC/NS) | 4/4 correct, ~-34 dB |
| `channelmix.disable = true` in pipewire-pulse | broken: silence nearly everywhere, and the remap tracks even `ended` | 4-channel streams silent, aiff 4/4 OK, remaps as flaky as by default |

- In every case, the silent tracks stayed `readyState "live"` and `muted false`, and fired
  no events. **The app gets no signal that a mic has gone dead.**
- This is not a browser bug. `control.sh` reproduces it without a browser: one libpulse
  client (`pa_multi.py`) recording the 4 remap sources gets **NO DATA or partial data**
  on 1–3 of the streams, while the same client on the 4 independent sources gets 3.0 s
  of clean data on each. 4 *separate* `parec` processes on the remaps are also clean.
  The trigger is several record streams from **one PulseAudio client** on sources that
  **share one graph driver**. Remaps (loopbacks), and also plain `pw-link` fan-out into
  4 mono virtual sources (tried, same failure), all follow `mic4_aux`'s driver. A browser
  is always one client: Chromium's audio service, or Firefox's cubeb context.
- A smaller graph quantum (`clock.force-quantum 256`) made both browsers clean in this
  run. The Python control still showed partial stalls at 256, so read this as "reduces
  it", not "fixes it". Chromium asks for 1024 frames (`settings.latency` 0.0213 s).
- When it works, the remap workaround gives exactly the isolation you want: each mono
  remap carries only its own tone. Chromium upmixes a mono remap to 2 identical channels.
  Firefox keeps it as 1 channel.

### 5: deviceId and label stability (persistent profile, new page each time)

| Action | Chromium | Firefox |
|---|---|---|
| Unload and reload remap, **same** `source_name` | deviceId **same**, label same | same, same |
| Reload with a **different** `source_name`, same description | deviceId **changes**, label same | deviceId **same** (keyed on label/description), label same |
| Restart browser, same profile | deviceId same | deviceId same |
| groupId | changes on every reload | changes on reload |
| Open track when its source is unloaded | still `live`, not muted, 1.5 s later; `ended` a few seconds later | `ended` within 1.5 s |

Chromium's deviceId is a per-origin hash of the PulseAudio source **name**. Pin the
`source_name` in config and the id survives module reloads and browser restarts. The
label (the `device.description`) is the friendlier key, and it is stable in both
browsers.

### 6: sample rate and AudioContext

- Chromium `getSettings().sampleRate` = 48000, `sampleSize` 16 (s16le stream), and
  capabilities sampleRate {48000..48000}. Firefox reports no sampleRate.
- An `AudioContext({sampleRate: 44100})` changed nothing about which channels arrive or
  their content. Resampling happens inside the browser. The PipeWire graph stayed at
  48 kHz.
- Neither browser exposes the source's real channel positions. Chromium's
  `InputDeviceInfo.getCapabilities().channelCount` says max 2 even for a 4-channel
  source.

## Caveats

- **Virtual sources only.** The 4-channel source is a timer-driven null-sink, not an ALSA
  device. On the real UMC404HD the driver is the ALSA node, and the concurrent-remap
  stall may be better, worse or different. Steps 1–3 depend only on what the browser asks
  PulseAudio for, so they should transfer. **Step 4 must be re-checked on the Stage**
  with real remaps and 4 concurrent getUserMedia calls, for minutes rather than seconds.
- The container has no RT scheduling (rtkit is unavailable), so scheduling jitter is
  higher than on the Stage.
- The concurrent-remap failure is timing-dependent. It reproduced in every default run
  here (3 full runs plus about 10 debug runs), but one early run had Chromium 4/4 clean in
  the raw case. Turning on pipewire-pulse debug logging hid it (heisenbug).
- Stationary sine tones are a poor fit for processing-on modes: AGC and noise suppression
  attenuate them by about 20 dB, so the "defaults" rows say more about channel handling
  than about level.
- `--use-fake-ui-for-media-stream` and Firefox's `permission.disabled` skip the
  permission prompt. They do not change device handling.
