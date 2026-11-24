# Browser microphone capture limits

Research for [issue #4](https://github.com/Marcowich0/OpenStar/issues/4). Sources read on 2026-11-24.

Targets: **desktop Chromium** (the Stage), **iPhone Safari** and **Android Chrome** (Phones).

Every claim carries a source. A claim marked **Unverified** has no primary source behind it: either none was found, or the only evidence is old or second-hand. Nothing here was measured on a device; this is a reading of specs, vendor documentation, bug trackers and browser source code.

## Answer in short

| Topic | Desktop Chromium | iPhone Safari | Android Chrome |
| --- | --- | --- | --- |
| Needs a secure context | Yes | Yes | Yes |
| Several input devices at once | Allowed by the spec; **unverified** in Chromium | No: a second capture mutes the first | **Unverified**; not needed for a Phone |
| Channels per device | At most 2 | 1 | 1 by default |
| Turn off echo cancellation | Yes | Yes | Yes |
| Turn off noise suppression and gain control separately | Yes | No such constraints | Yes |
| AudioWorklet | Chrome 66 | Safari 14.5 (iOS) | Chrome 66 |
| Sample rate of a raw track | The device's own rate | **Unverified** | The device's own rate |
| Input latency figure | None published | None published | None published |
| Capture with the page hidden or the screen locked | Not a Stage concern | Unreliable; treat as lost | **Unverified**; treat as lost |
| Screen Wake Lock | Chrome 84 | Safari 16.4; Home Screen apps from 18.4 | Chrome 84 |

## 1. Secure context

All three targets need a secure context for microphone capture. This is the fact with the widest consequences: Phones reach the server over the local network, and a plain `http://192.168.x.x` address is not secure.

- `navigator.mediaDevices` and `getUserMedia()` are marked `[SecureContext]` in the specification, so in an insecure page `navigator.mediaDevices` is `undefined`. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [MDN: getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- An origin counts as potentially trustworthy when its scheme is `https` or `wss`, when its host is in `127.0.0.0/8` or `::1/128`, when its host is `localhost` or ends in `.localhost` (if the browser resolves those names to loopback), or when its scheme is `file`. A browser may also let a user configure an origin as trustworthy for development. Everything else, including a private LAN address over `http`, is not trustworthy. [Secure Contexts, section 3.1](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy)
- Chromium's own list of secure origins matches: `https`, `wss`, `localhost`, `127/8`, `::1/128`, `file`. [Chromium: Prefer Secure Origins For Powerful New Features](https://www.chromium.org/Home/chromium-security/prefer-secure-origins-for-powerful-new-features/)
- WebKit requires the capturing document to come from HTTPS. Desktop Safari has a developer menu item, "Allow Media Capture on Insecure Sites", to bypass this for testing. [WebKit blog: A Closer Look Into WebRTC](https://webkit.org/blog/7763/a-closer-look-into-webrtc/) (2017)
- AudioWorklet and the Screen Wake Lock API are also restricted to secure contexts. [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/), [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/)

Consequences:

- The Stage can use `http://localhost` only when the browser runs on the same machine as the server. From any other machine, and from every Phone, the server must be served over HTTPS.
- **Unverified:** whether iPhone Safari has any setting that lets an insecure origin capture. The WebKit bypass above is documented for desktop Safari's Develop menu only.
- **Unverified:** whether a page reached by clicking through a certificate warning (a self-signed certificate) counts as a secure context on each target. The deployment decision should assume a certificate the Phones already trust.

## 2. Several input devices at once

**Desktop Chromium.** The specification puts no limit on it: each `getUserMedia()` call returns a stream with at most one audio track, a `deviceId` constraint selects the device, and nothing forbids holding several streams. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/). **Unverified:** no first-party Chromium statement was found that confirms two or more input devices capture reliably at the same time. This needs a short test on the Stage hardware.

**iPhone Safari.** One capture at a time.

- A WebKit engineer states that on iOS a second `getUserMedia()` call takes precedence and all tracks of the first stream are muted. [WebKit bug 180748, comment 10](https://bugs.webkit.org/show_bug.cgi?id=180748#c10) (2018; no later statement found that changes this)
- WebKit lets only one tab capture at a time; a tab that loses capture receives the `mute` event on its tracks. [WebKit blog: A Closer Look Into WebRTC](https://webkit.org/blog/7763/a-closer-look-into-webrtc/) (2017)

A Phone is one mic for one Player, so this does not block the design. It does mean an iPhone or iPad cannot serve as the Stage with several mics, and that a Phone page must never call `getUserMedia()` twice.

**Android Chrome.** **Unverified.** Not needed for a Phone.

## 3. Channels of a stereo or multichannel device

**Desktop Chromium: two channels at most.** Chromium's audio layer reduces every input device to mono or stereo before the web page sees it:

- Windows: any input format that is not mono is rewritten to stereo. [core_audio_util_win.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/media/audio/win/core_audio_util_win.cc#L1149-L1157)
- macOS: the device's channel count is used only when it is 2 or less; otherwise stereo. [audio_manager_mac.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/media/audio/mac/audio_manager_mac.cc#L679-L686)
- Linux with PulseAudio: input is always opened as stereo. [audio_manager_pulse.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/media/audio/pulse/audio_manager_pulse.cc#L149-L153)
- The same limit is described in a W3C issue as long-standing Chromium behaviour. [w3c/mediacapture-main issue 1021](https://github.com/w3c/mediacapture-main/issues/1021#issuecomment-2493093628) (third-party comment)

What the page gets depends on audio processing. With Chromium's processing on, the track is mono or has the device's channel count. With processing off, the track has the device's channel count. [media_stream_constraints_util_audio.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc). The `channelCount` constraint is supported since Chrome 59. [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/MediaStreamTrack.json)

In Web Audio, a `MediaStreamAudioSourceNode` outputs as many channels as its track has, so a `ChannelSplitterNode` can separate left and right. [Web Audio API 1.1, MediaStreamAudioSourceNode](https://www.w3.org/TR/webaudio-1.1/#MediaStreamAudioSourceNode)

So a two-mic USB dongle that presents one stereo device (one mic per channel) can feed two Players on the Stage: request `channelCount: 2` with echo cancellation, noise suppression and gain control off, then split the channels. A four-channel interface gives only two usable channels. **Unverified:** that a given dongle really delivers its two mics as separate left and right channels through Chromium on the owner's operating system; this depends on the device and needs a test.

**iPhone Safari: one channel.** WebKit does not implement the `channelCount` constraint (it is a `FIXME` in the list of supported constraints), and the bug asking for stereo capture is still open, with a comment from September 2026 saying capture is still mono. [MediaTrackSupportedConstraints.idl](https://github.com/WebKit/WebKit/blob/7d082cb35957d0845f93cab2b17ea068539032b2/Source/WebCore/Modules/mediastream/MediaTrackSupportedConstraints.idl), [WebKit bug 210231](https://bugs.webkit.org/show_bug.cgi?id=210231)

**Android Chrome: one channel by default.** Chromium opens Android input as mono unless a feature flag (`AudioStereoInputStreamParameters`) is on. [audio_manager_android.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/media/audio/android/audio_manager_android.cc#L529-L538)

## 4. Echo cancellation, noise suppression, gain control

Pitch detection wants the raw signal, so all three should be off.

**Desktop Chromium and Android Chrome.** `echoCancellation` is supported since Chrome 59, `noiseSuppression` and `autoGainControl` since Chrome 67. [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/MediaStreamTrack.json). With all processing off, Chromium uses an "unprocessed" source that keeps the device's own channel count and sample rate. [media_stream_constraints_util_audio.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc). **Unverified:** whether an Android phone still applies its own hardware or system processing to the microphone after the page turns the browser's processing off.

**iPhone Safari.** Only `echoCancellation` exists. WebKit's list of supported constraints has `echoCancellation`, `sampleRate`, `sampleSize`, `volume`, `deviceId` and `groupId` for audio, and no `noiseSuppression` or `autoGainControl`; compat data agrees. [MediaTrackSupportedConstraints.idl](https://github.com/WebKit/WebKit/blob/7d082cb35957d0845f93cab2b17ea068539032b2/Source/WebCore/Modules/mediastream/MediaTrackSupportedConstraints.idl), [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/MediaStreamTrack.json). **Unverified:** that `echoCancellation: false` on an iPhone also removes the system's noise suppression and gain control. The phone latency prototype should check this by looking at the captured signal.

On every target, read back `track.getSettings()` after capture: a constraint that is not `exact` may be ignored without an error. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

## 5. AudioWorklet

Supported on all three targets: Chrome 66 (desktop and Android) and Safari 14.1 on macOS, which corresponds to Safari 14.5 on iOS. [MDN browser-compat-data: AudioWorklet](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/AudioWorklet.json), [MDN: AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)

- It needs a secure context. [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/)
- A worklet processes audio in blocks of 128 frames by default (about 2.7 ms at 48 kHz). [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/)
- In Safari a new `AudioContext` starts suspended until `resume()` is called from a user action such as a tap. [MDN browser-compat-data: AudioContext](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/AudioContext.json). The Phone's join flow therefore needs a tap before capture starts.

## 6. Sample rates

- **Chromium, processing on:** the track is at 48 kHz, the rate of Chromium's audio processing. [media/webrtc/constants.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/media/webrtc/constants.cc), [media_stream_constraints_util_audio.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc)
- **Chromium, processing off:** the track is at the device's own rate, and that is the only rate offered. [media_stream_constraints_util_audio.cc](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc)
- **iPhone Safari:** the `sampleRate` constraint is supported. [MediaTrackSupportedConstraints.idl](https://github.com/WebKit/WebKit/blob/7d082cb35957d0845f93cab2b17ea068539032b2/Source/WebCore/Modules/mediastream/MediaTrackSupportedConstraints.idl). **Unverified:** which rates an iPhone actually delivers.
- **All targets:** when a track's rate differs from the `AudioContext`'s rate, the browser resamples the track on its way into the graph. [Web Audio API 1.1, MediaStreamAudioSourceNode](https://www.w3.org/TR/webaudio-1.1/#MediaStreamAudioSourceNode). The `sampleRate` option of the `AudioContext` constructor is supported from Chrome 74 and Safari 14.1. [MDN browser-compat-data: AudioContext](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/AudioContext.json)

The pitch detector must read `audioContext.sampleRate` at run time and not assume 44.1 or 48 kHz.

## 7. Input latency

**No primary source publishes a measured browser microphone latency for any of the three targets.** Every number for this must come from OpenStar's own measurement.

What the platform does expose:

- `AudioContext.baseLatency` and `outputLatency` describe the output side only. There is no input-latency attribute in Web Audio. [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/). `outputLatency` is supported from Chrome 102 and Safari 18.4. [MDN browser-compat-data: AudioContext](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/AudioContext.json)
- A track has a `latency` setting and constraint in the specification. Chrome supports it from version 59; Safari does not (it is a `FIXME` in WebKit). [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/MediaStreamTrack.json), [MediaTrackSupportedConstraints.idl](https://github.com/WebKit/WebKit/blob/7d082cb35957d0845f93cab2b17ea068539032b2/Source/WebCore/Modules/mediastream/MediaTrackSupportedConstraints.idl). **Unverified:** how close Chrome's reported value is to the real delay.
- Android's compatibility rules guarantee little for ordinary phones: a device with a microphone must only have a cold input latency of 500 ms or less. Tighter limits apply only to devices that declare the low-latency or pro-audio features, and those are defined against the native AAudio API, not a browser. [Android 16 Compatibility Definition, sections 5.6 and 5.10](https://source.android.com/docs/compatibility/16/android-16-cdd)

So latency varies per device, cannot be read from an API on iPhone, and has no guaranteed upper bound on Android. This supports the map's plan of per-mic calibration and a phone latency prototype.

## 8. Screen lock, backgrounding and the Wake Lock API

**What the specification asks.** When a page is not in view, a browser should mute a capture track and not unmute it until the page is in view again; a lock screen is named as a case where capture should not resume. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/). A browser that mutes capture for a hidden page is therefore following the specification.

**iPhone Safari.** Capture while Safari is in the background or the screen is locked is not dependable.

- A WebKit engineer says a page that is capturing the microphone is not suspended in the background. [WebKit bug 204681, comment 5](https://bugs.webkit.org/show_bug.cgi?id=204681#c5) (2020)
- The same bug, still open, reports the audio track going to `ended`, or staying `live` but silent, after Safari has been in the background for 30 to 60 seconds. WebKit ends a track when its capture callback stops arriving for a few seconds. Calling `getUserMedia()` again was reported to recover from the `ended` state. [WebKit bug 204681](https://bugs.webkit.org/show_bug.cgi?id=204681) (reports from iOS 13)
- A report that the mic stops when the iPhone auto-locks (iOS 15.5) was closed because WebKit could not reproduce it on iOS 15.6. [WebKit bug 241400](https://bugs.webkit.org/show_bug.cgi?id=241400)
- **Unverified:** the behaviour on the current iOS version. All the evidence above is from iOS 13 to 15.

**Android Chrome.** **Unverified.** Chromium has an Android service that shows a notification while a page captures, and it runs as a foreground service only when a "background media capturing" feature is enabled. [MediaCaptureNotificationServiceImpl.java](https://github.com/chromium/chromium/blob/e6c45bcd91074b2db0619bd479cf3c66f4062bd0/chrome/android/java/src/org/chromium/chrome/browser/media/MediaCaptureNotificationServiceImpl.java). Whether that feature is on for phones, and whether capture survives a locked screen, was not established.

**Desktop Chromium.** Background tabs have their timers throttled, except pages that play audible audio or hold a WebSocket or WebRTC connection. [Chrome for Developers: Background tabs in Chrome 57](https://developer.chrome.com/blog/background_tabs) (2017). The Stage is the visible, full-screen page, so this should not arise.

**Screen Wake Lock API.** This is the tool that keeps a Phone from locking.

- Supported in Chrome 84 on desktop and Android. [MDN browser-compat-data: WakeLock](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/WakeLock.json)
- Added in Safari 16.4. [Safari 16.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes). It was broken in Home Screen web apps until Safari 18.4. [Safari 18.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes). Compat data lists iOS support from 18.4 for that reason. [MDN browser-compat-data: WakeLock](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/api/WakeLock.json)
- It only keeps the screen on. It does not keep a hidden page running. [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/)
- Only a visible page can acquire the lock, and the lock is released automatically whenever the page becomes hidden. The page must request it again on `visibilitychange`. [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/)
- The browser may refuse or release the lock, for example on low battery. [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/)

Working rule for the design: a Phone captures only while its page is visible and its screen is on. The Phone page holds a screen wake lock while it is a mic, re-requests it on `visibilitychange`, watches the track's `mute`, `unmute` and `ended` events, and calls `getUserMedia()` again after `ended`. The Stage must be told when a Phone's mic drops out.

## Facts later decisions most depend on

1. **HTTPS is mandatory for Phones.** A LAN address over `http` cannot capture a microphone on any target. Deployment must provide a certificate the Phones trust.
2. **The Stage gets at most two channels per input device.** A stereo two-mic dongle can serve two Players; a four-channel interface cannot serve four through one device. Four local Players need two stereo devices, or four separate devices, captured at once, and that simultaneous capture is unverified in Chromium.
3. **A Phone is exactly one mono mic.** iPhone Safari captures one channel and one device at a time; Android Chrome opens input as mono.
4. **Raw capture is possible everywhere, with a gap on iPhone.** Chromium can turn off each processing step; Safari offers only `echoCancellation`.
5. **AudioWorklet is available on all three targets**, so pitch detection can run in the browser on a Phone or on the Stage.
6. **No latency figure exists to design against.** It must be measured per mic; an iPhone exposes no input latency value.
7. **A Phone's mic lives only while its page is visible.** Screen Wake Lock keeps the screen on; it does not survive the user switching apps.

## Left for the prototypes

- Two or more input devices captured at once in desktop Chromium, on the Stage's operating system.
- Whether the owner's wired mics appear as one stereo device with a mic per channel.
- Whether `echoCancellation: false` on an iPhone gives an unprocessed signal.
- Sample rates delivered by real iPhones and Android phones.
- Input latency per target and how much it varies between devices.
- What a current iPhone and a current Android phone do to capture on screen lock and on app switch.
- Whether a self-signed certificate gives a secure context on each target.
