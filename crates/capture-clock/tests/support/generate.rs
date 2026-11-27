//! Makes the generated case files of `fixtures/capture-clock/`. The device
//! model and the reference rules here are deliberately naive (whole histories,
//! sorted scans), so they share nothing with the crate's ring buffers.

/// xorshift32, as in the detector fixtures.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        f64::from(x) / 4_294_967_296.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
    fn exp(&mut self, mean: f64) -> f64 {
        -mean * (1.0 - self.next()).ln()
    }
}

/// Rounds to `places` decimals.
fn round(v: f64, places: i32) -> f64 {
    let p = 10f64.powi(places);
    (v * p).round() / p
}

/// A JSON number as Prettier leaves it: shortest form, no `.0`.
fn n(v: f64) -> String {
    let s = format!("{v}");
    if s == "-0" { "0".into() } else { s }
}

fn on(v: Option<f64>) -> String {
    v.map_or("null".into(), n)
}

const HOP: f64 = 512.0;
const FIRST_END_FRAME: f64 = 2048.0;

/// The spec's rules, written out the plain way.
#[derive(Default)]
struct Reference {
    spreads: Vec<f64>,
    samples: Vec<(f64, f64, f64)>, // (epoch, round trip, offset)
    epoch_started_by: f64,         // t0 of the first sample of the epoch
    remote: bool,
}

impl Reference {
    fn stamp_device(&mut self, end_frame: f64, sample_rate: f64, handled: f64) -> f64 {
        let f = end_frame / sample_rate * 1000.0;
        self.spreads.push(handled - f);
        let from = self.spreads.len().saturating_sub(100);
        let k = self.spreads[from..]
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min);
        f + k - 1024.0 / sample_rate * 1000.0
    }
    fn pong(&mut self, t0: f64, t1: f64, ts: f64, epoch: f64) -> bool {
        let new_epoch = self.samples.last().is_none_or(|s| s.0 != epoch);
        if new_epoch {
            if !self.samples.is_empty() && t0 < self.epoch_started_by {
                return false;
            }
            self.samples.clear();
            self.epoch_started_by = t0;
        }
        self.samples.push((epoch, t1 - t0, ts - (t0 + t1) / 2.0));
        new_epoch
    }
    fn offset(&self) -> Option<f64> {
        if !self.remote {
            return Some(0.0);
        }
        let from = self.samples.len().saturating_sub(30);
        let mut best: Option<(f64, f64)> = None;
        for &(_, rtt, offset) in &self.samples[from..] {
            if best.is_none_or(|(b, _)| rtt <= b) {
                best = Some((rtt, offset));
            }
        }
        best.map(|b| b.1)
    }
}

/// How the main thread handles the worklet's messages.
#[derive(Clone, Copy)]
enum Delay {
    /// A floor of 1 ms and a little exponential jitter (mean 2 ms).
    Quiet,
    /// Load that changes every 2 s (jitter mean 1 ms, then 15 ms) and stalls
    /// of 20–60 ms (3 % of readings start one), during which nothing is handled.
    Varying,
    /// About 3 holds a second of 50–100 ms (one in 10 up to 270 ms); what was
    /// held is handled at once when the hold ends, in order.
    Bursts,
}

struct Reading {
    end_frame: f64,
    handled: f64,
    /// True window-centre time on the device clock.
    centre: f64,
}

/// One capture stream: the audio clock runs at `rate` × real time, frame 0
/// is at `start_ms` on the device clock (which is real time).
fn stream(
    rng: &mut Rng,
    sample_rate: f64,
    rate: f64,
    start_ms: f64,
    duration_ms: f64,
    delay: Delay,
) -> Vec<Reading> {
    let frame_real = |frame: f64| start_ms + frame / (sample_rate * rate) * 1000.0;
    let mut out: Vec<Reading> = Vec::new();
    let mut busy_until = f64::NEG_INFINITY;
    let mut hold_until = f64::NEG_INFINITY;
    let mut last_handled = f64::NEG_INFINITY;
    let mut end_frame = FIRST_END_FRAME;
    loop {
        let made = frame_real(end_frame);
        if made > start_ms + duration_ms {
            break;
        }
        let mut handled = match delay {
            Delay::Quiet => made + 1.0 + rng.exp(2.0),
            Delay::Varying => {
                let heavy = ((made - start_ms) / 2000.0).floor() as i64 % 2 == 1;
                if made >= busy_until && rng.next() < 0.03 {
                    busy_until = made + rng.uniform(20.0, 60.0);
                }
                let t = made + 1.0 + rng.exp(if heavy { 15.0 } else { 1.0 });
                if made < busy_until {
                    t.max(busy_until)
                } else {
                    t
                }
            }
            Delay::Bursts => {
                if made >= hold_until && rng.next() < 3.0 * HOP / sample_rate {
                    let long = rng.next() < 0.1;
                    hold_until = made
                        + if long {
                            rng.uniform(100.0, 270.0)
                        } else {
                            rng.uniform(50.0, 100.0)
                        };
                }
                let t = made + 1.0 + rng.exp(2.0);
                if made < hold_until {
                    t.max(hold_until)
                } else {
                    t
                }
            }
        };
        // One thread handles them in order.
        handled = handled.max(last_handled + 0.01);
        last_handled = handled;
        out.push(Reading {
            end_frame,
            handled: round(handled, 3),
            centre: round(frame_real(end_frame - 1024.0), 3),
        });
        end_frame += HOP;
    }
    out
}

struct File {
    description: String,
    session: &'static str,
    spread_max: Option<f64>,
    steps: Vec<String>,
}

impl File {
    fn text(&self) -> String {
        let mut s = format!(
            "{{\n  \"description\": {},\n  \"session\": \"{}\",\n",
            serde_json::to_string(&self.description).expect("string"),
            self.session
        );
        if let Some(max) = self.spread_max {
            s += &format!("  \"trueTimeSpreadMaxMs\": {},\n", n(max));
        }
        s += "  \"steps\": [\n";
        s += &self
            .steps
            .iter()
            .map(|l| format!("    {l}"))
            .collect::<Vec<_>>()
            .join(",\n");
        s += "\n  ]\n}\n";
        s
    }
}

/// A mapping case on a local session (offset 0, so the stamp is the device
/// stamp): one or more streams, each after a `start`. Readings after the
/// first `warmup` of a stream carry their true time.
fn mapping_case(
    description: &str,
    seed: u32,
    streams: &[(f64, f64, f64, f64, Delay, usize, bool)],
    spread_max: f64,
) -> File {
    let mut rng = Rng(seed);
    let mut reference = Reference::default();
    let mut steps = Vec::new();
    for &(sample_rate, rate, start_ms, duration_ms, delay, warmup, checked) in streams {
        steps.push(format!("[\"start\", {}, {}]", n(start_ms), n(sample_rate)));
        reference.spreads.clear();
        for (i, r) in stream(&mut rng, sample_rate, rate, start_ms, duration_ms, delay)
            .into_iter()
            .enumerate()
        {
            let stamp = round(
                reference.stamp_device(r.end_frame, sample_rate, r.handled),
                6,
            );
            let truth = if checked && i >= warmup {
                format!(", {}", n(r.centre))
            } else {
                String::new()
            };
            steps.push(format!(
                "[\"reading\", {}, {}, {}{}]",
                n(r.end_frame),
                n(r.handled),
                n(stamp),
                truth
            ));
        }
    }
    File {
        description: description.into(),
        session: "local",
        spread_max: Some(spread_max),
        steps,
    }
}

/// The Stage's clock as a function of the device clock, per epoch.
struct Stage {
    epoch: f64,
    offset: f64,
    drift: f64,
}

impl Stage {
    fn at(&self, device_ms: f64) -> f64 {
        device_ms * (1.0 + self.drift) + self.offset
    }
}

/// Network delays one way: a floor, exponential jitter and occasional holds.
fn net(rng: &mut Rng, floor: f64, mean: f64, hold_p: f64, hold: (f64, f64)) -> f64 {
    let mut d = floor + rng.exp(mean);
    if rng.next() < hold_p {
        d += rng.uniform(hold.0, hold.1);
    }
    d
}

/// The spec's cadence: is a ping due at `t` after a ping at `last`?
fn due(last: Option<f64>, fast_since: f64, t: f64) -> bool {
    match last {
        None => t >= fast_since,
        Some(l) => {
            let interval = if l < fast_since + 5000.0 {
                200.0
            } else {
                1000.0
            };
            t >= l + interval
        }
    }
}

struct RemoteCase {
    description: &'static str,
    seed: u32,
    end_ms: f64,
    /// The Stage reloads at this device time: a new epoch and clock.
    reload_at: Option<f64>,
    /// The connection to the Stage is made again at this time.
    reconnect_at: Option<f64>,
    /// Readings from this stream, if any.
    readings: Option<(f64, f64, Delay)>,
    /// Whether to write an `offset` check after every pong.
    offset_checks: bool,
    spread_max: Option<f64>,
}

/// A remote session over 1 ms ticks: pings on the spec's cadence, pongs back
/// after uneven random delays, readings (if any) as they are handled.
fn remote_case(c: &RemoteCase) -> File {
    let mut rng = Rng(c.seed);
    let mut reference = Reference {
        remote: true,
        ..Reference::default()
    };
    let mut stage = Stage {
        epoch: 1_764_000_000_123.25,
        offset: 123_456.789,
        drift: 15e-6,
    };
    let sample_rate = c.readings.map_or(48000.0, |r| r.0);
    let mut steps = vec![format!("[\"start\", 0, {}]", n(sample_rate))];
    let readings = c
        .readings
        .map(|(sample_rate, rate, delay)| stream(&mut rng, sample_rate, rate, 0.0, c.end_ms, delay))
        .unwrap_or_default();
    let mut next_reading = 0;
    // In flight: (t1, t0, ts, epoch).
    let mut pongs: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut last_ping: Option<f64> = None;
    let mut fast_since = 0.0;
    let mut t = 0.0;
    while t <= c.end_ms {
        if c.reload_at.is_some_and(|r| r == t) {
            // A new page: its performance.now() starts near 0.
            stage = Stage {
                epoch: stage.epoch + t + 3000.5,
                offset: -t + 17.125,
                drift: -9e-6,
            };
        }
        if c.reconnect_at.is_some_and(|r| r == t) {
            steps.push(format!("[\"restartSync\", {}]", n(t)));
            reference.samples.clear();
            pongs.clear();
            fast_since = t;
        }
        // Pongs whose t1 has come, in order of arrival.
        pongs.sort_by(|a, b| a.0.total_cmp(&b.0));
        while pongs.first().is_some_and(|p| p.0 <= t) {
            let (t1, t0, ts, epoch) = pongs.remove(0);
            steps.push(format!(
                "[\"pong\", {}, {}, {}, {}]",
                n(t0),
                n(t1),
                n(ts),
                n(epoch)
            ));
            if reference.pong(t0, t1, ts, epoch) {
                fast_since = t1;
            }
            if c.offset_checks {
                steps.push(format!(
                    "[\"offset\", {}]",
                    on(reference.offset().map(|o| round(o, 6)))
                ));
            }
        }
        while next_reading < readings.len() && readings[next_reading].handled <= t {
            let r = &readings[next_reading];
            let device = reference.stamp_device(r.end_frame, sample_rate, r.handled);
            let stamp = reference.offset().map(|o| round(device + o, 6));
            // A reading stamped before the sender has heard of a new epoch
            // is on the old Stage clock: no true time on the current one.
            let current = reference.samples.last().is_some_and(|s| s.0 == stage.epoch);
            let truth = match (stamp, c.spread_max, next_reading >= 100 && current) {
                (Some(_), Some(_), true) => format!(", {}", n(round(stage.at(r.centre), 3))),
                _ => String::new(),
            };
            steps.push(format!(
                "[\"reading\", {}, {}, {}{}]",
                n(r.end_frame),
                n(r.handled),
                on(stamp),
                truth
            ));
            next_reading += 1;
        }
        if due(last_ping, fast_since, t) {
            steps.push(format!("[\"ping\", {}, {}]", n(t), n(t)));
            last_ping = Some(t);
            let there = net(&mut rng, 1.0, 5.0, 0.1, (50.0, 270.0));
            let back = net(&mut rng, 0.8, 1.5, 0.05, (50.0, 150.0));
            let ts = round(stage.at(t + there), 3);
            let t1 = round(t + there + back, 3);
            // A ping still on its way when the Stage page reloads is lost.
            let lost = c.reload_at.is_some_and(|r| t < r && t + there >= r);
            if !lost {
                pongs.push((t1, t, ts, stage.epoch));
            }
        }
        t += 1.0;
    }
    steps.push(format!(
        "[\"nextPing\", {}]",
        on(next_due(last_ping, fast_since))
    ));
    File {
        description: c.description.into(),
        session: "remote",
        spread_max: c.spread_max,
        steps,
    }
}

fn next_due(last: Option<f64>, fast_since: f64) -> Option<f64> {
    Some(match last {
        None => fast_since,
        Some(l) if l < fast_since + 5000.0 => l + 200.0,
        Some(l) => l + 1000.0,
    })
}

/// Every generated file, by name.
pub fn all() -> Vec<(String, String)> {
    let files = vec![
        (
            "steady.json",
            mapping_case(
                "An audio clock at its nominal rate (48 kHz), main-thread delay 1 ms plus exponential jitter (mean 2 ms). Stamps follow the true window centre from the first reading: their error is the delay of the least-delayed reading so far, so it shrinks from the first reading's own jitter to the 1 ms floor (limit 4 ms over the whole stream).",
                0x1d2c_3b4a,
                &[(48000.0, 1.0, 1000.0, 3000.0, Delay::Quiet, 0, true)],
                4.0,
            ),
        ),
        (
            "slow-clock-1pct.json",
            mapping_case(
                "An audio clock 1 % slow (44.1 kHz nominal), quiet main thread. After the first 100 readings fill the envelope, stamps follow the true window centre at a constant lag (the drift over the envelope's 1 s, about 11 ms here, which Calibration absorbs into the Mic delay); the spread limit is about the jitter, not the lag.",
                0x2b3a_4958,
                &[(44100.0, 0.99, 500.0, 4000.0, Delay::Quiet, 100, true)],
                2.0,
            ),
        ),
        (
            "slow-clock-8pct.json",
            mapping_case(
                "An audio clock 8 % slow (48 kHz nominal), quiet main thread. After the first 100 readings, stamps follow the true window centre at a constant lag of about 95 ms (the drift over the envelope's 1 s); they do not drift away over the 5 s. The 4 ms they vary by is the jitter of the oldest readings in the envelope: at this drift the oldest reading nearly always holds the minimum.",
                0x3c4b_5a69,
                &[(48000.0, 0.92, 500.0, 5000.0, Delay::Quiet, 100, true)],
                5.0,
            ),
        ),
        (
            "varying-delay.json",
            mapping_case(
                "An audio clock 3 % slow, main-thread delay that varies: load alternating every 2 s between jitter of mean 1 ms and mean 15 ms, and stalls of 20-60 ms in which nothing is handled. Handling delays spread over about 80 ms; the stamps spread over under 13 ms. With a drifting clock the minimum sits on the oldest readings of the envelope, so heavy jitter there still shows (about the drift times the readings it skips); with a clock at its nominal rate it would not.",
                0x4d5c_6b7a,
                &[(48000.0, 0.97, 0.0, 8000.0, Delay::Varying, 100, true)],
                14.0,
            ),
        ),
        (
            "bursts.json",
            mapping_case(
                "An audio clock 5 % slow, readings delivered in bursts: about 3 holds a second of 50-100 ms (one in 10 up to 270 ms), then everything held at once. Handling delays spread over about 185 ms; the stamps spread over under 11 ms, the drift (5 %) times the longest hold, by which the minimum moves to a newer reading while the oldest readings of the envelope were held.",
                0x5e6d_7c8b,
                &[(48000.0, 0.95, 0.0, 8000.0, Delay::Bursts, 100, true)],
                12.0,
            ),
        ),
        (
            "reset.json",
            mapping_case(
                "A stream at 44.1 kHz for 3 s (its frame counter far along), then capture starts again on a new AudioContext at 48 kHz whose counter starts from 0, 500 ms later. After the reset the old spreads are gone and stamps follow the new counter from its first reading (only the second stream carries true times).",
                0x6f7e_8d9c,
                &[
                    (44100.0, 0.98, 0.0, 3000.0, Delay::Quiet, 0, false),
                    (48000.0, 1.0, 3500.0, 3000.0, Delay::Quiet, 0, true),
                ],
                1.0,
            ),
        ),
        (
            "lowest-round-trip.json",
            remote_case(&RemoteCase {
                description: "Clock sync with uneven random delays: there 1 ms + exponential (mean 5 ms), 1 in 10 held 50-270 ms more; back 0.8 ms + exponential (mean 1.5 ms), 1 in 20 held 50-150 ms more. The Stage's clock is 123456.789 ms ahead and runs 15 ppm fast. After every pong the offset is that of the lowest round trip among the last 30 samples.",
                seed: 0x7a8b_9cad,
                end_ms: 40000.0,
                reload_at: None,
                reconnect_at: None,
                readings: None,
                offset_checks: true,
                spread_max: None,
            }),
        ),
        (
            "stage-reload.json",
            remote_case(&RemoteCase {
                description: "A Phone singing while the Stage page reloads at 7 s: a new epoch and a new clock. Readings are dropped until the first pong, then stamped on the Stage's clock; the first pong of the new epoch discards every earlier sample, takes over the offset at once and brings the 200 ms pings back for 5 s. Stamps follow the true capture time on whichever Stage clock is current (audio clock 2 % slow, quiet main thread, the same network as lowest-round-trip).",
                seed: 0x8b9c_adbe,
                end_ms: 13000.0,
                reload_at: Some(7000.0),
                reconnect_at: None,
                readings: Some((48000.0, 0.98, Delay::Quiet)),
                offset_checks: true,
                spread_max: Some(5.0),
            }),
        ),
        (
            "reconnect.json",
            remote_case(&RemoteCase {
                description: "No offset, no readings: readings handled before the first pong are dropped, never held back and sent later. At 6 s, after the fast pings have ended, the Phone's connection is made again (restartSync): every sample is discarded, readings are dropped again until the next pong, and the pings are fast again for 5 s.",
                seed: 0x9cad_becf,
                end_ms: 12000.0,
                reload_at: None,
                reconnect_at: Some(6000.0),
                readings: Some((44100.0, 0.99, Delay::Quiet)),
                offset_checks: true,
                spread_max: None,
            }),
        ),
    ];
    files
        .into_iter()
        .map(|(name, file)| (name.to_string(), file.text()))
        .collect()
}
