# Release checklist

This is everything CI can't check: real Phones over Wi-Fi, real audio interfaces, the Stage PC's display, the owner's real Library and the real USDB. `just ci` checks everything else, and no item below repeats it.

- **When:** work through this checklist by hand before each `vX.Y.Z` tag.
- **Not for `:edge`:** `:edge` builds from `main` need none of it. Every merge still publishes an image.
- **Where it comes from:** [v1 spec: Testing, CI and release checklist](https://github.com/Marcowich0/OpenStar/issues/58). Vocabulary: [`GLOSSARY.md`](../GLOSSARY.md).

## How to work through it

1. **Make a worked copy.** Open a GitHub issue titled `Release checklist vX.Y.Z`. Paste the [checklist items](#checklist-items) into it, from the first group heading to the end of the Network and Downloads group.
2. **Work every item** on the release candidate image, the build that will be tagged.
   - Tick an item when it passes.
   - Write each value an item asks you to record next to that item in the issue, with the device, browser and OS version it came from.
   - Compare each recorded value with the reference the item names, and with the value in the last release's issue.
3. **Handle a failing item** as described in [When an item fails](#when-an-item-fails). Don't tag while an item fails.
4. **Tag and keep the copy.** When every item passes, tag `vX.Y.Z`. Link the issue from the GitHub Release notes, then close it. The closed `Release checklist vX.Y.Z` issues are the record of every release's checks and recorded values.

## When an item fails

- **An item that verifies an assumption** is marked **Verifies:** and links the assumption in [the v1 spec's Assumptions](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). If it fails, the assumption is wrong, and **the decision that rests on the assumption is reopened**. Reopen the decision issue that the [assumption register](#assumption-register) names, or comment on it if it can't be reopened, with the failing values. Label it `needs-triage` and link it from the worked copy. The release waits until the decision is settled again.
- **Any other failing item** is a bug. File it as an issue, label it `needs-triage`, and link it from the worked copy. The release waits for the fix.
- **For a deeper look** at a failing item, use the [measurement rigs](#measurement-rigs).

## Checklist items

The numbers are the ones [v1 spec: Testing, CI and release checklist](https://github.com/Marcowich0/OpenStar/issues/58) uses, so references to "item 6" stay valid. Items 21 and 22 come from the [v1 spec's Assumptions](https://github.com/Marcowich0/OpenStar/issues/43#assumptions) table, which names them as checklist items but they weren't among the area's twenty. They are numbered after the twenty and placed with the Stage.

### Library

- [ ] **1. `just corpus` against the owner's real Library.**
      Run `just corpus <path to the Library>`.
      **Passes:** no crash, and every file comes back byte-identical when unedited. Every reject is listed and expected (for example a 2.0.0 or relative-mode file).
      **Record:** the number of Songs, rejects and warnings, and the encodings detected. Compare them with the last release's issue.
      **Verifies:** [files marked 1.2.0 read correctly under the 1.x rules, and `chardetng` tells CP1250 from CP1252](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

### Phones

- [ ] **2. Android Chrome as a Phone.**
      **Passes:** the Phone joins over HTTPS, sings a whole Song with the screen on and its mic stays open to the end, and Calibrate mics passes.
      **Verifies:** [a Phone's mic stays dependable for a whole Song while its page is visible and the screen is on](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **3. iPhone Safari as a Phone, on the owner's Wi-Fi.**
      **Passes:**
  - Calibrate mics and the Mic threshold work;
  - the mic survives a whole Song with the screen on.

  **Record:** which of `echoCancellation`, `noiseSuppression` and `autoGainControl` Safari reports as honoured. The reference is what Android Chrome reports in item 2.
  A design change is needed only if the mic can't stay open for a whole Song.
  **Verifies:** [iPhone Safari behaves like Android Chrome as a Phone](https://github.com/Marcowich0/OpenStar/issues/43#assumptions), and [a Phone's mic stays dependable for a whole Song while its page is visible and the screen is on](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

- [ ] **4. The Rust WASM detector on an Android Phone and an iPhone.**
      **Record:** its cost per frame (median and p95) and the readings per second, on each Phone.
      **Reference:** `pitchy`, measured on Android: 0.1 ms a frame, 0.7 ms at p95, about 92 readings a second.
      **Verifies:** [the Rust MPM detector in WASM costs a Phone about what `pitchy` did](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **5. Calibration on an iPhone.**
      **Record:** the Mic delay it finds, and its spread (the standard deviation over the tones).
      **Reference:** the 100 ms Phone default for the Mic delay, and the 25 ms failure spread.
      **Verifies:** [the Phone default Mic delay and the 25 ms spread limit hold beyond one OnePlus 12](https://github.com/Marcowich0/OpenStar/issues/43#assumptions), and [iPhone Safari behaves like Android Chrome as a Phone](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

### Bleed

- [ ] **6. Bleed with a real Song, on a Phone and on a Local mic.**
      Calibrate the Mic first. Play a whole real Song with nobody singing, then sing it normally.
      **Passes:** with nobody singing, at most 4 % of Beats are hit; normal singing still scores.
      **Record:** the share of Beats hit with nobody singing, on each Mic.
      **Verifies:** [the Mic threshold separates a real Song's Bleed from singing](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). It was measured only with synthetic tones on Phones and one Song on an SM58.

### Local mics on the Stage PC

- [ ] **7. A Local mic read by the Stage browser.**
      **Passes:** it is switched on and named, "Calibrate this mic now" passes, and it scores in a Song. After unplugging and replugging its device, and after restarting the browser, it is found again with its name and Mic delay.
      **Verifies:** [Chromium's `deviceId` for a Local mic survives replugging and restarts](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **8. Two input devices captured at once by the Stage browser.**
      **Passes:** each device gives its Local mics, and both sing in the same Song.
      **Verifies:** [the Stage browser can capture two input devices at once](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

### Mic bridge and interfaces

- [ ] **9. Scarlett 4i4 inputs 3–4.**
      Feed inputs 3–4 with a line source.
      **Passes:** in Pro Audio, both arrive clean and separate from inputs 1–2.
      **Verifies:** [through the Mic bridge, inputs 3–4 arrive clean and separate](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). They were live but never fed a signal.
- [ ] **10. A long run with every input on.**
      Run at least one whole Song with every input switched on.
      **Passes:** no dropouts, and no channel goes silent.
      **Verifies:** [through the Mic bridge, every channel survives a long run](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). The long run was skipped when the bridge was measured.
- [ ] **11. Behringer UMC404HD.**
      **Passes:** it offers Pro Audio with 4 `AUX` channels and no loopback; all 4 inputs are clean and separate; "Calibrate this mic now" passes on each.
      **Record:** the Mic threshold Calibration sets on each input. **Reference:** the −40 dBFS Local mic default.
      **Verifies:** [the UMC404HD gives Pro Audio with 4 `AUX` channels](https://github.com/Marcowich0/OpenStar/issues/43#assumptions), and [the −40 dBFS Local mic default suits other dynamic mics](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **12. Switch to Pro Audio.**
      **Passes:** it works from the installed, unsandboxed binary. In a sandbox, it falls back to the copyable `pactl` command.
      **Verifies:** [Switch to Pro Audio works from the installed bridge](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). It was read from source only.
- [ ] **13. The interface profile after a reboot.**
      **Passes:** after a reboot, the interface is back in the profile it was switched to.
      **Verifies:** [WirePlumber restores the profile after a reboot](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **14. Find it after a profile switch.**
      **Passes:** **Find it** re-links a Stage-browser Local mic after a profile switch, keeping its name, Mic delay and bleed level.
      **Verifies:** [**Find it** repairs a profile switch](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **15. The install script on fresh desktops.**
      Run it on a fresh CachyOS desktop and on a fresh Ubuntu 22.04 desktop.
      **Passes:** it verifies the server's SHA-256, installs the binary, menu entry, icon and server address, and the bridge starts.
      **Verifies:** [the bridge binary runs on desktops with glibc ≥ 2.35, and its install script works](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **16. The bridge updates itself.**
      **Passes:** the bridge updates itself after a server upgrade, and again after a rollback, verifying the server's SHA-256 each time.
      **Verifies:** [the bridge's self-update works](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **17. Calibration of a Local mic, read by the browser and by the bridge.**
      **Record:** for each, the Mic delay it finds and its spread (standard deviation).
      **Reference:** its default Mic delay (the reported input delay, or 0), and the 25 ms failure spread.
      **Verifies:** [the 25 ms spread limit holds beyond one OnePlus 12](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

### Stage

- [ ] **18. The sing screen at 4K and 144 Hz with 8 lanes.**
      Open the Stage with `?perf&lanes=8`: 8 synthetic lanes fed by recorded readings, a duet, full effects and the music video. Read the frame-time overlay.
      **Passes:** the sing screen holds the refresh rate: frame times stay within 6.9 ms (one frame at 144 Hz), with no dropped frames.
      **Record:** the median and p95 frame time, with the Stage PC's GPU and browser version.
      **Verifies:** [a 2D canvas holds the refresh rate at 4K and 144 Hz with 8 lanes](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **21. Stage playback of an H.264 Song and a converted Song.**
      Play a Song whose media is H.264 and AAC, and a Song whose media had to be converted into `/appdata/cache` (for example an AVI or WMA Song added for the check).
      **Passes:** both play picture and sound to the end in the Stage browser; the converted Song plays from its cached H.264 + AAC MP4.
      **Verifies:** [the Stage browser plays H.264 and AAC](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **22. Check A/V sync on a TV and a soundbar.**
      With the Stage's sound going through the soundbar, run **Check A/V sync** and set the A/V offset.
      **Passes:**
  - after setting it, the bouncing ball lines up with the sound, and picture and sound stay in step through a whole Song;
  - after restarting the browser, and after unplugging and replugging the output, the stored A/V offset is found again for that output;
  - switching to another output shows "Sound output changed" and uses that output's own value.

  **Record:** the A/V offset set for each output.
  **Verifies:** [Chromium keeps picture and sound in step with sound routed through the Stage's `AudioContext`, and the default output's label stays stable](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

### Network and Downloads

- [ ] **19. The Caddy HTTPS path from `compose.caddy.yaml`.**
      **Passes:** Phones join through the QR code over HTTPS, trusting the proxy's certificate, and their mics open.
      **Verifies:** [OpenStar runs on a trusted local network behind a proxy whose certificate Phones trust](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).
- [ ] **20. A real Download from USDB with real credentials.**
      **Passes:** login, mirror fill, search, video pick, and the finished Song appears in the Library.
      **Verifies:** [USDB's logged-in pages behave as researched, and USDB tolerates one request a second](https://github.com/Marcowich0/OpenStar/issues/43#assumptions).

## Checks done once while building

These are not repeated for each release. Each was done once, while building the part it checks.

- **The Song clock at 144 Hz in real Chromium**, as part of building the clock ([v1 spec: Song clock, playback and A/V offset](https://github.com/Marcowich0/OpenStar/issues/53)).
- **Vincent re-checked by hand with Auto-fit**, since its audio can't be committed ([v1 spec: Timing editor and Auto-fit](https://github.com/Marcowich0/OpenStar/issues/57)). Run Auto-fit in the built app on the original, misaligned Vincent. It passes when Auto-fit proposes the prototype's fix (`#GAP` 3650 → 753 and `#BPM` 217.4 → 216.26, within a few milliseconds and 0.01) and the Notes then line up with the singing (the prototype raised the Notes on the singing from 15 % to 62 %). As the v1 spec decides, this one check also stands for the assumption that Auto-fit works beyond the Song it was tuned on.
  **Verifies:** [Auto-fit works on other Songs than the one it was tuned on](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). A failure reopens [Timing editor interaction](https://github.com/Marcowich0/OpenStar/issues/20#issuecomment-7138137297) and [Where auto-fit computes its pitch track](https://github.com/Marcowich0/OpenStar/issues/35#issuecomment-7142823813).

**Accepted without a check:** [Rust's unmeasured scan time, relay tail and idle memory do not change the choice of language](https://github.com/Marcowich0/OpenStar/issues/43#assumptions). They are never measured, on purpose, since none could reverse the choice of Rust ([Backend runtime performance candidates](https://github.com/Marcowich0/OpenStar/issues/8#issuecomment-7125580122), [Backend language and stack](https://github.com/Marcowich0/OpenStar/issues/11#issuecomment-7130122147)).

## Assumption register

Each assumption from [the v1 spec's Assumptions](https://github.com/Marcowich0/OpenStar/issues/43#assumptions), the items that verify it, and the decision reopened if one of them fails.

| Assumption                                                                                                                                                                | Verified by                                                     | Decision reopened if it fails                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone Safari behaves like Android Chrome as a Phone: same mic constraints honoured, same pipeline, mic survives a whole Song, calibration and Mic threshold work         | 3, 5                                                            | [iPhone Safari phone mic check](https://github.com/Marcowich0/OpenStar/issues/31#issuecomment-7155928197)                                                                                                                                                                                                                     |
| A Phone's mic stays dependable for a whole Song while its page is visible and the screen is on                                                                            | 2, 3                                                            | [Browser microphone capture limits](https://github.com/Marcowich0/OpenStar/issues/4#issuecomment-7125543350), [Phone mic end-to-end latency](https://github.com/Marcowich0/OpenStar/issues/10#issuecomment-7138854113)                                                                                                        |
| The Rust MPM detector in WASM costs a Phone about what `pitchy` did (0.1 ms a window)                                                                                     | 4                                                               | [Local mic mapping](https://github.com/Marcowich0/OpenStar/issues/33#issuecomment-7144876194)                                                                                                                                                                                                                                 |
| The Mic threshold separates a real Song's Bleed from singing                                                                                                              | 6                                                               | [From Pitch readings to a beat's value](https://github.com/Marcowich0/OpenStar/issues/22#issuecomment-7139152763), [Loudness gate for Local mics](https://github.com/Marcowich0/OpenStar/issues/40#issuecomment-7156127094)                                                                                                   |
| The Phone default Mic delay (about 100 ms) and the 25 ms spread limit hold beyond one OnePlus 12; the −40 dBFS Local mic default suits other dynamic mics                 | 5, 11, 17                                                       | [Mic delay calibration](https://github.com/Marcowich0/OpenStar/issues/30#issuecomment-7139765997), [Four inputs through the mic bridge](https://github.com/Marcowich0/OpenStar/issues/38#issuecomment-7155617317)                                                                                                             |
| Through the Mic bridge, inputs 3–4 arrive clean and separate, every channel survives a long run, and the UMC404HD gives Pro Audio with 4 `AUX` channels                   | 9, 10, 11                                                       | [Four inputs through the mic bridge](https://github.com/Marcowich0/OpenStar/issues/38#issuecomment-7155617317)                                                                                                                                                                                                                |
| Switch to Pro Audio works from the installed bridge, and WirePlumber restores the profile after a reboot                                                                  | 12, 13                                                          | [Interface profile for the Mic bridge](https://github.com/Marcowich0/OpenStar/issues/39#issuecomment-7156082650)                                                                                                                                                                                                              |
| Chromium's `deviceId` for a Local mic survives replugging and restarts, **Find it** repairs a profile switch, and the Stage browser can capture two input devices at once | 7, 8, 14                                                        | [Browser microphone capture limits](https://github.com/Marcowich0/OpenStar/issues/4#issuecomment-7125543350), [Local mic mapping](https://github.com/Marcowich0/OpenStar/issues/33#issuecomment-7144876194), [Interface profile for the Mic bridge](https://github.com/Marcowich0/OpenStar/issues/39#issuecomment-7156082650) |
| The bridge binary runs on desktops with glibc ≥ 2.35, and its install script and self-update work                                                                         | 15, 16                                                          | [Mic bridge packaging](https://github.com/Marcowich0/OpenStar/issues/41#issuecomment-7157225092)                                                                                                                                                                                                                              |
| The Stage browser plays H.264 and AAC (Chrome or Edge, or a Chromium with proprietary codecs)                                                                             | 21                                                              | [UltraStar song format and library conventions](https://github.com/Marcowich0/OpenStar/issues/2#issuecomment-7125594514)                                                                                                                                                                                                      |
| Files marked 1.2.0 read correctly under the 1.x rules, and `chardetng` tells CP1250 from CP1252                                                                           | 1                                                               | [UltraStar song format and library conventions](https://github.com/Marcowich0/OpenStar/issues/2#issuecomment-7125594514)                                                                                                                                                                                                      |
| USDB's logged-in pages behave as researched, and USDB tolerates one request a second                                                                                      | 20                                                              | [How the existing downloader gets songs](https://github.com/Marcowich0/OpenStar/issues/7#issuecomment-7125533696)                                                                                                                                                                                                             |
| A 2D canvas holds the refresh rate at 4K and 144 Hz with 8 lanes                                                                                                          | 18                                                              | [Frontend stack and rendering](https://github.com/Marcowich0/OpenStar/issues/12#issuecomment-7132188247)                                                                                                                                                                                                                      |
| Chromium keeps picture and sound in step with sound routed through the Stage's `AudioContext`, and the default output's label stays stable                                | 22                                                              | [Song clock and media playback](https://github.com/Marcowich0/OpenStar/issues/27#issuecomment-7140006944), [Stage A/V offset](https://github.com/Marcowich0/OpenStar/issues/32#issuecomment-7141047552)                                                                                                                       |
| OpenStar runs on a trusted local network behind a proxy whose certificate Phones trust; the Admin PIN guards against pranks and mistakes, not a determined attacker       | 19                                                              | [Network exposure and HTTPS](https://github.com/Marcowich0/OpenStar/issues/18#issuecomment-7130225309), [Admin PIN](https://github.com/Marcowich0/OpenStar/issues/34#issuecomment-7142572607)                                                                                                                                 |
| Auto-fit works on other Songs than the one it was tuned on                                                                                                                | Once while building ([above](#checks-done-once-while-building)) | [Timing editor interaction](https://github.com/Marcowich0/OpenStar/issues/20#issuecomment-7138137297), [Where auto-fit computes its pitch track](https://github.com/Marcowich0/OpenStar/issues/35#issuecomment-7142823813)                                                                                                    |
| Rust's unmeasured scan time, relay tail and idle memory do not change the choice of language                                                                              | Accepted without a check                                        | [Backend runtime performance candidates](https://github.com/Marcowich0/OpenStar/issues/8#issuecomment-7125580122), [Backend language and stack](https://github.com/Marcowich0/OpenStar/issues/11#issuecomment-7130122147)                                                                                                     |

## Measurement rigs

For a deeper look at a failing item, these rigs stay on their throwaway branches:

- [`prototypes/phone-mic-latency`](https://github.com/Marcowich0/OpenStar/tree/b61f2dc8a9a82674fc2fa9428a77ec0321c346de/prototypes/phone-mic-latency): a Phone mic's latency, detector cost, readings per second and Bleed (items 2–6).
- [`prototypes/pitch-trace-smoothing/ab`](https://github.com/Marcowich0/OpenStar/tree/7351e9644c7fbc0b04320233ad85160df861b938/prototypes/pitch-trace-smoothing/ab): measures Wi-Fi holds of a Phone's readings (items 2, 3, 19).
- [`tasks/four-inputs-mic-bridge`](https://github.com/Marcowich0/OpenStar/tree/e619f9ed4d18af7338d512d0b4f50be988da8a58/tasks/four-inputs-mic-bridge): capture of every input through the Mic bridge (items 9–13).
