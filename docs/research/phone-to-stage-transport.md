# Phone-to-stage transport options

Research for issue #6. Sources were read on 2026-11-24. Every claim carries a source; anything marked **unverified** was not confirmed in a primary source and must not be relied on without a measurement.

## Question

How can a Phone's singing reach the Stage in time to be scored? Compare sending audio (WebRTC, WebSocket PCM, WebTransport) with sending only detected pitch values, on: latency and jitter on Wi-Fi, clock synchronisation between Phone and Stage, need for a server relay or TURN, behaviour on iPhone Safari, and complexity.

## Short answer

Send **pitch values, not audio**, and stamp each value on the Phone with a time on a clock that has been synchronised to the Stage. Score by that timestamp, not by arrival time. The transport then only has to be "fast enough for the on-screen pitch trace", and a plain **WebSocket through the OpenStar server** is sufficient; an unordered, no-retransmit **WebRTC data channel** is the optional upgrade if the prototype shows the WebSocket trace stuttering on Wi-Fi.

Reasons, each expanded below:

1. Both open-source phone-as-mic karaoke games that were inspected send pitch, not audio (AllKaraoke, UltraStar Play Companion).
2. Every audio transport either adds delay that the Stage cannot see exactly (Opus look-ahead plus an adaptive jitter buffer in WebRTC) or requires building a jitter buffer and capture-time bookkeeping by hand (PCM over WebSocket or WebTransport).
3. With timestamps, network latency and jitter stop affecting the score at all. They only delay the visual feedback.
4. WebSocket works on every target browser and needs nothing the project does not already have. WebTransport needs HTTP/3, special certificates, and iOS 26.4 or later.
5. One constraint is shared by all four options and is the real deployment problem: the Phone page must be served over HTTPS, or the microphone is not available at all.

## Facts that apply to every option

**The microphone needs a secure context.** `MediaDevices` is declared `[SecureContext]` in the Media Capture and Streams spec, and MDN states that in an insecure context `navigator.mediaDevices` is `undefined`; a secure context is a page loaded over HTTPS, from `file:///`, or from `localhost` ([W3C mediacapture-streams](https://www.w3.org/TR/mediacapture-streams/), [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security)). WebKit says the same for Safari: the document "needs to come from a HTTPS domain" ([WebKit: A Closer Look Into WebRTC](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)). A Phone opening `http://192.168.x.x` therefore cannot be a mic, whichever transport is chosen. How the self-hosted server gets a certificate that phones trust is outside this ticket but blocks all of it.

**The Stage is a browser, so it cannot listen.** A browser page can open WebSocket, WebTransport and WebRTC connections but cannot accept inbound ones. WebSocket and WebTransport are therefore always Phone → server → Stage. Only WebRTC can go Phone → Stage directly, and it still needs the server to carry the signalling ([RFC 8827 §4.1](https://www.rfc-editor.org/rfc/rfc8827#section-4.1) describes the signalling-server model).

**Audio start-up needs a tap.** An `AudioContext` created outside a user gesture starts `suspended` and must be resumed from a user-initiated event ([MDN Web Audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices#autoplay_policy)). The Phone's join flow needs one tap that both resumes audio and requests the mic.

**Capture defaults are wrong for singing.** `echoCancellation`, `autoGainControl` and `noiseSuppression` are standard constraints ([W3C mediacapture-streams](https://www.w3.org/TR/mediacapture-streams/#def-constraint-echoCancellation)). They are designed for speech calls. Whether iPhone Safari honours turning each of them off is **unverified** here; it belongs to the browser-microphone ticket.

**Capture in `AudioWorklet` is available everywhere in scope.** `AudioWorklet`: Chrome 66, Safari and iOS Safari 14.1 ([MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/AudioWorklet.json), read at commit `2f696a2565ef`).

**iPhone Safari allows one capturing tab.** "WebKit only allows one tab to capture video or audio at a time"; a tab that loses capture sees its track muted and receives a `mute` event ([WebKit: Announcing WebRTC and Media Capture](https://webkit.org/blog/7726/announcing-webrtc-and-media-capture/)). The Phone page must handle `mute`. What happens to capture when the iPhone screen locks or Safari goes to the background is **unverified**.

## Option A: WebRTC audio (Opus over RTP)

- **Path.** Phone and Stage exchange an offer and answer through the server, then media can flow directly between them. ICE collects *host candidates*, which are obtained "directly from a local interface" ([RFC 8445 §2.1](https://www.rfc-editor.org/rfc/rfc8445#section-2.1)). Two devices on one subnet can connect on host candidates alone, so **no STUN or TURN server is needed in one room**, provided the Wi-Fi lets clients reach each other. Access-point "client isolation" would break this; that is an inference from how host candidates work, not something a spec states.
- **Safari and host candidates.** Without capture permission WebKit exposes only server-reflexive and TURN candidates. "When access is granted, WebKit will expose host ICE candidates" ([WebKit: A Closer Look Into WebRTC](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)). The Phone always has mic permission, so its host candidates are available. The Stage has none unless it also captures a mic. ICE can still discover a path from the Stage's side as a peer-reflexive candidate during connectivity checks ([RFC 8445 §7.2.5.3.1](https://www.rfc-editor.org/rfc/rfc8445#section-7.2.5.3.1)); that this connects in practice when only the Phone exposes a host candidate is **unverified** and is a prototype check. Chromium replaces host IPs with mDNS names when there is no capture permission, as described in [draft-ietf-mmusic-mdns-ice-candidates](https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates-03); that this resolves reliably from an iPhone on a home network is **unverified**.
- **Codec delay.** Opus is the mandatory WebRTC codec ([RFC 7874 §3](https://www.rfc-editor.org/rfc/rfc7874#section-3)). Its algorithmic delay ranges from 5 ms to 65.2 ms depending on mode ([RFC 6716 §2](https://www.rfc-editor.org/rfc/rfc6716#section-2)), on top of the frame duration. The exact figure a browser uses is **unverified**.
- **Jitter buffer.** The receiver holds audio in an adaptive jitter buffer. `RTCRtpReceiver.jitterBufferTarget` lets the page request a target, but it "is a target value" and the user agent keeps its own minimum and maximum ([W3C WebRTC](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget)). Support: Chrome 124, Firefox 115, Safari 27 ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/RTCRtpReceiver.json)). The Stage is Chromium, so it is usable there. The buffer's delay varies during a song, so the delay between singing and the Stage's pitch detector is **not constant**.
- **Recovering capture time.** The Stage can read `getSynchronizationSources()[].timestamp` (when the latest frame was delivered to the track, on the Stage's `performance` clock; [W3C WebRTC](https://www.w3.org/TR/webrtc/#dom-rtcrtpcontributingsource-timestamp)) and the stats `jitterBufferDelay` and `estimatedPlayoutTimestamp`, the latter in the *sender's* NTP clock via RTCP sender reports ([W3C webrtc-stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-estimatedplayouttimestamp), [RFC 3550 §6.4.1](https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1)). A `captureTimestamp` field exists in the [WebRTC Extensions draft](https://w3c.github.io/webrtc-extensions/#rtcrtpcontributingsource-extensions) but depends on an RTP header extension; browser support is **unverified**. So aligning received audio to the song is possible but indirect, and still needs a Phone-to-Stage clock offset.
- **Upside.** The Stage gets real audio, so one pitch detector serves local mics and Phones alike, and loss is concealed by the codec.
- **Complexity.** High: signalling, ICE, reconnection, codec and processing settings, and jitter-buffer compensation.

## Option B: PCM over WebSocket

- **Path.** Phone → server → Stage, always relayed. WebSocket is "layered over TCP" ([RFC 6455, abstract](https://www.rfc-editor.org/rfc/rfc6455)), so delivery is ordered and reliable: one lost Wi-Fi frame delays everything behind it until it is retransmitted. That stall is exactly what unreliable datagrams exist to avoid ([RFC 9221 §1](https://www.rfc-editor.org/rfc/rfc9221#section-1)).
- **Size.** Mono 16-bit PCM at 48 kHz is 48 000 × 16 = 768 kbit/s per Phone, 3.1 Mbit/s for four. This is arithmetic, not a measurement; whether a busy home Wi-Fi carries it without stalls is **unverified**.
- **Latency.** No codec delay and no built-in jitter buffer. The Stage must build its own buffer to feed a pitch detector continuously, or run the detector per chunk and accept gaps.
- **Capture time.** Each chunk can carry the Phone's own timestamp, so alignment is straightforward once clocks are synchronised (see below).
- **Safari.** WebSocket has been in Safari since version 5 ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/WebSocket.json)).
- **Complexity.** Medium: a worklet that posts buffers, binary framing, a relay path in the server that copies audio at 768 kbit/s per Phone, and a Stage-side buffer.

## Option C: WebTransport (audio or pitch as datagrams)

- **Path.** Client to server only; a session runs "over an HTTP/3 or HTTP/2 underlying connection" ([W3C WebTransport §3.1](https://www.w3.org/TR/webtransport/#webtransport-session)). Always relayed, like WebSocket. Datagrams are unreliable and never retransmitted ([RFC 9221](https://www.rfc-editor.org/rfc/rfc9221)), so there is no head-of-line stall.
- **Support.** Chrome 97, Firefox 114, **Safari and iOS Safari 26.4** ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/WebTransport.json); announced in [WebKit Features for Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/), 24 March 2026). An iPhone that has not been updated past iOS 26.3 has no WebTransport, so a fallback transport would be required anyway.
- **Certificates.** The interfaces are `[SecureContext]`. A server without a Web-PKI certificate can be reached with `serverCertificateHashes`, but that certificate's validity period "MUST NOT exceed two weeks" and RSA keys are not allowed; ECDSA P-256 is the interoperable choice ([W3C WebTransport, custom certificate requirements](https://www.w3.org/TR/webtransport/#custom-certificate-requirements), [MDN WebTransport constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport#servercertificatehashes)). The server would have to mint and rotate these itself.
- **Server.** The backend must terminate HTTP/3 (QUIC over UDP). This narrows the backend-stack choice and adds a UDP port to the Docker deployment.
- **Complexity.** High for a one-room game: it buys datagram semantics that a WebRTC data channel already offers on every target browser.

## Option D: pitch values only

- **What is sent.** The Phone runs pitch detection in an `AudioWorklet` and sends small messages: a timestamp, a pitch and a level. A few dozen bytes at tens of messages per second.
- **Prior art, read from source:**
  - **AllKaraoke** (MIT, web, phones as mics; commit [`1a00071`](https://github.com/Asvarox/allkaraoke/tree/1a00071a3ea78cb27e25f252f6312e8e9b989ecf)). The Phone batches detected frequencies and sends `{ t: 'freq', 0: number[], 1: volume }`, sampled at about 60 Hz and flushed every 50 ms ([`network-client.ts`](https://github.com/Asvarox/allkaraoke/blob/1a00071a3ea78cb27e25f252f6312e8e9b989ecf/src/modules/remote-mic/network/client/network-client.ts), [`docs/network.md`](https://github.com/Asvarox/allkaraoke/blob/1a00071a3ea78cb27e25f252f6312e8e9b989ecf/docs/network.md)). Messages travel over WebRTC data channels through a hosted SFU ([`sfu-session.ts`](https://github.com/Asvarox/allkaraoke/blob/1a00071a3ea78cb27e25f252f6312e8e9b989ecf/src/modules/network/realtime/sfu-session.ts)). There is **no timestamp and no clock sync**: the game stamps a batch on arrival as `currentTime - inputLag`, where `inputLag` is a per-mic calibration constant, and spreads the batch's values evenly back to the previous batch ([`player-state.ts`](https://github.com/Asvarox/allkaraoke/blob/1a00071a3ea78cb27e25f252f6312e8e9b989ecf/src/modules/game-engine/game-state/player-state.ts)). Ping is measured only to label a mic `unstable` above 500 ms and `unavailable` above 1500 ms ([`remote-mic-input.tsx`](https://github.com/Asvarox/allkaraoke/blob/1a00071a3ea78cb27e25f252f6312e8e9b989ecf/src/modules/game-engine/input/remote-mic-input.tsx)). Network jitter therefore lands directly in the score timing.
  - **UltraStar Play Companion** (MIT, native app, same game family as USDX; commit [`a4aaa0b`](https://github.com/UltraStar-Deluxe/Play/tree/a4aaa0b31327)). The game pushes its *position in the song* to the phone. The phone keeps several such messages, picks the one most consistent with the others to reject delayed deliveries, and extrapolates the current song position from its own clock. It then analyses the mic samples that belong to each song beat, minus the mic's calibrated delay, and sends `{ Beat, MidiNote, Frequency }` ([`ClientSideMicDataSender.cs`](https://github.com/UltraStar-Deluxe/Play/blob/a4aaa0b31327/UltraStar%20Play%20Companion/Assets/Common/Network/ClientSideMicDataSender.cs), [`BeatPitchEventDto.cs`](https://github.com/UltraStar-Deluxe/Play/blob/a4aaa0b31327/UltraStar%20Play/Packages/playshared/Runtime/CompanionClientCommunication/Dto/BeatPitchEventDto.cs)). Events are keyed to the **song timeline**, so arrival time does not affect scoring. The game also tracks message delay and jitter for display ([`CompanionClientHandler.cs`](https://github.com/UltraStar-Deluxe/Play/blob/a4aaa0b31327/UltraStar%20Play/Assets/Common/CompanionClientConnections/CompanionClientHandler.cs)).
- **Transport choices.** WebSocket through the server (simplest), or an `RTCDataChannel` created with `ordered: false, maxRetransmits: 0`, which gives unordered, unreliable delivery directly between Phone and Stage ([RFC 8831 §5 and §6.1](https://www.rfc-editor.org/rfc/rfc8831#section-6.1), [W3C WebRTC `RTCDataChannel`](https://www.w3.org/TR/webrtc/#rtcdatachannel)). Both exist in Safari since 11 ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/RTCDataChannel.json)).
- **Cost.** Pitch detection runs on the Phone, so the Stage never hears the voice. Anything needing audio on the Stage (recording is out of scope for v1) would not work, and detector quality depends on each Phone's CPU. Local Stage mics and Phones run the same detector code but in different places.
- **Complexity.** Low for the transport. The work moves to clock synchronisation, which is small (next section).

## Clock synchronisation

**The method.** NTP's on-wire calculation needs four timestamps: client send `T1`, server receive `T2`, server send `T3`, client receive `T4`. Then offset `θ = ½[(T2 − T1) + (T3 − T4)]` and round-trip delay `δ = (T4 − T1) − (T3 − T2)` ([RFC 5905 §8](https://www.rfc-editor.org/rfc/rfc5905#section-8)). The formula assumes the two directions take equal time, so a sample with a long round trip is less trustworthy. NTP's clock filter keeps the last eight samples, sorts them by increasing delay and takes the offset of the lowest-delay one ([RFC 5905 §10](https://www.rfc-editor.org/rfc/rfc5905#section-10)). For OpenStar: the Phone pings repeatedly over the same connection, keeps the lowest-delay samples, and repeats during the song to follow drift.

**Which clocks.** `performance.now()` is monotonic and, outside cross-origin isolation, coarsened to 100 µs ([MDN performance.now](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#security_requirements)), far finer than needed. `AudioContext.getOutputTimestamp()` returns a `contextTime` and the matching `performanceTime`, which ties the audio clock to the `performance` clock; `outputLatency` estimates the delay until sound leaves the device ([Web Audio API](https://www.w3.org/TR/webaudio-1.1/#dom-audiocontext-getoutputtimestamp)). Support: `getOutputTimestamp` in Chrome 57 and Safari 14.1; `outputLatency` in Chrome 102 and Safari 18.4 ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json)).

**What sync does and does not remove.** This paragraph is reasoning from the facts above, not a sourced claim. The chain is: Phone mic hardware and OS input delay → Phone audio clock → Phone `performance` clock → (offset θ) → Stage `performance` clock → Stage song position → Stage output delay (speakers, TV, Bluetooth). Clock sync removes the network from that chain: latency and jitter no longer move a pitch value on the song timeline. It does not remove the two fixed ends, Phone input delay and Stage output delay. Those are constant per device, which is what per-mic latency calibration is for. Without sync (AllKaraoke's design) the calibration constant also has to absorb the average network delay, and jitter stays as noise.

**Two shapes of the same idea.** Either the Phone converts its capture time to Stage time and sends that (NTP-style, described above), or the Stage pushes its song position and the Phone keys pitch to song beats itself (UltraStar Play Companion). The first keeps the Phone ignorant of the song; the second sends less and lets the Phone align analysis windows to beats. Choosing between them depends on where scoring windows are defined, which is another ticket.

## Latency and jitter on Wi-Fi

No primary source gives trustworthy numbers for one-room Wi-Fi with phones, and none is quoted here. Round-trip time, jitter and loss for each transport on real devices are **unverified** and are what the phone latency prototype should measure. What the sources do establish is the structure of the delay:

| Component | A: WebRTC audio | B: WS PCM | C: WebTransport | D: pitch only |
| --- | --- | --- | --- | --- |
| Codec look-ahead | 5–65.2 ms algorithmic ([RFC 6716](https://www.rfc-editor.org/rfc/rfc6716#section-2)) | none | none if PCM | none |
| Receive buffer | adaptive, browser-controlled | hand-built | hand-built | none needed |
| Loss handling | concealment | TCP retransmit, stalls | dropped | WS: stalls; data channel: dropped |
| Effect of jitter on score | moves audio in time unless compensated | none if chunks are timestamped | none if timestamped | none if timestamped |

## Comparison

| | A: WebRTC audio | B: WebSocket PCM | C: WebTransport | D: pitch only (WebSocket or data channel) |
| --- | --- | --- | --- | --- |
| What the Stage receives | decoded audio track | raw PCM chunks | PCM or pitch datagrams | timestamped pitch values |
| Where pitch is detected | Stage | Stage | Stage or Phone | Phone |
| Added delay | Opus + adaptive jitter buffer, varies | network + own buffer | network + own buffer | network only, and irrelevant to score |
| Jitter sensitivity of scoring | high unless compensated via stats | none with timestamps | none with timestamps | none with timestamps |
| Clock sync needed | yes, plus jitter-buffer accounting | yes (NTP-style) | yes (NTP-style) | yes (NTP-style or pushed song position) |
| Server relay | signalling only; media is direct | all audio, 768 kbit/s per Phone | all traffic, over HTTP/3 | tiny messages (WS) or signalling only (data channel) |
| STUN or TURN | not needed on one subnet (host candidates) | n/a | n/a | n/a (WS); not needed on one subnet (data channel) |
| iPhone Safari | supported since 11; host candidates after mic permission | supported | **26.4 or later only** | supported |
| Extra server requirements | signalling endpoint | binary relay | HTTP/3, UDP port, short-lived ECDSA certs or Web-PKI cert | none beyond the app's WebSocket |
| Proven in an open-source karaoke game | not found | not found | not found | AllKaraoke, UltraStar Play Companion |
| Complexity | high | medium | high | low |
| Needs HTTPS on the Phone page | yes | yes | yes | yes |

## Facts later decisions most depend on

1. **HTTPS is mandatory for the Phone page** in every option. A trusted certificate for a self-hosted LAN server has to be solved before any Phone can be a mic.
2. **Pitch-only moves pitch detection onto the Phone.** That settles "where pitch detection runs" for Phones: the detector must run in an `AudioWorklet` on iPhone Safari and Android Chrome.
3. **Timestamping makes scoring independent of network latency.** Calibration then only has to measure fixed device delays (Phone input, Stage output), not the network.
4. **AllKaraoke does not timestamp and absorbs the network into a calibration constant.** UltraStar Play Companion keys pitch to song beats on the phone. The second is the design to copy.
5. **A WebSocket through the server is enough** for pitch values; WebRTC data channels are an upgrade path, not a prerequisite. WebTransport is not worth its cost here.
6. **The numbers are missing.** Wi-Fi latency, jitter and loss per transport on real phones are unverified and belong to the prototype ticket.

## Not verified

- Wi-Fi latency, jitter and loss figures for any option.
- Whether iPhone Safari honours disabling echo cancellation, noise suppression and auto gain control.
- What happens to mic capture when the iPhone screen locks or Safari is backgrounded.
- The Opus frame size and resulting delay each browser actually uses, and the smallest jitter buffer Chromium will hold.
- Browser support for `captureTimestamp` (abs-capture-time).
- Whether Chromium's mDNS host candidates resolve reliably from an iPhone on a typical home network.
- Whether a direct WebRTC connection forms when only the Phone exposes a host candidate.
- Whether access-point client isolation is common enough to matter for direct Phone-to-Stage WebRTC.
- UltraStar Play Companion's wire transport (its `MicDataDeliveryMethod` setting was seen but not read).
- No open-source web karaoke or rhythm game that streams phone audio to a shared screen was found; the search was not exhaustive.
