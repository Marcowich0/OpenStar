//! Runs the synthetic detector cases in `fixtures/detector/` against the
//! native build: MPM behind a `ReadingMaker`, fed in audio blocks at every
//! sample rate each case lists. `fixtures/detector/README.md` defines the
//! signals and the limits; the WASM build runs the same files.

use openstar_detector::{Mpm, PitchReading, ReadingMaker, SILENCE_DBFS, WINDOW_LEN};
use serde::Deserialize;
use std::f64::consts::{SQRT_2, TAU};
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaseFile {
    #[allow(dead_code)]
    description: String,
    sample_rates: Vec<f64>,
    block_len: usize,
    waveform: Waveform,
    duration_s: f64,
    vibrato: Option<Vibrato>,
    signals: Vec<Signal>,
    limits: Limits,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Waveform {
    Sine,
    Sawtooth,
    Noise,
    Silence,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vibrato {
    rate_hz: f64,
    depth_cents: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Signal {
    midi: Option<f64>,
    level_dbfs: Option<f64>,
    seed: Option<u32>,
    onset_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    median_cents_max: Option<f64>,
    p99_cents_max: Option<f64>,
    clarity_below: Option<f64>,
    loudness_tolerance_db: Option<f64>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/detector")
}

fn load(name: &str) -> CaseFile {
    let path = fixtures_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// One signal generated at one sample rate, as the README defines it.
struct Generated {
    samples: Vec<f32>,
    onset_frame: u64,
}

fn generate(file: &CaseFile, signal: &Signal, sample_rate: f64) -> Generated {
    let len = (file.duration_s * sample_rate).round() as usize;
    let onset_frame = (signal.onset_s.unwrap_or(0.0) * sample_rate).round() as usize;
    let rms = signal
        .level_dbfs
        .map(|db| 10f64.powf(db / 20.0))
        .unwrap_or(0.0);
    let mut samples = vec![0.0f32; len];
    let body = &mut samples[onset_frame..];

    match file.waveform {
        Waveform::Silence => {}
        Waveform::Noise => {
            let mut x = signal.seed.expect("noise needs a seed");
            let amplitude = 3f64.sqrt() * rms;
            for sample in body.iter_mut() {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let v = f64::from(x) / 4_294_967_296.0;
                *sample = (amplitude * (2.0 * v - 1.0)) as f32;
            }
        }
        Waveform::Sine | Waveform::Sawtooth => {
            let f0 =
                440.0 * 2f64.powf((signal.midi.expect("tones need a midi note") - 69.0) / 12.0);
            let depth = file.vibrato.map_or(0.0, |v| v.depth_cents);
            let harmonics =
                (0.45 * sample_rate / (f0 * 2f64.powf(depth / 1200.0))).floor() as usize;
            let saw_gain =
                rms / (0.5 * (1..=harmonics).map(|k| 1.0 / (k * k) as f64).sum::<f64>()).sqrt();
            let mut phase = 0.0f64;
            for (i, sample) in body.iter_mut().enumerate() {
                let value = match file.waveform {
                    Waveform::Sine => SQRT_2 * rms * phase.sin(),
                    _ => {
                        saw_gain
                            * (1..=harmonics)
                                .map(|k| (k as f64 * phase).sin() / k as f64)
                                .sum::<f64>()
                    }
                };
                *sample = value as f32;
                let u = i as f64 / sample_rate;
                phase += TAU * instantaneous_frequency(f0, file.vibrato, u) / sample_rate;
            }
        }
    }
    Generated {
        samples,
        onset_frame: onset_frame as u64,
    }
}

fn instantaneous_frequency(f0: f64, vibrato: Option<Vibrato>, u: f64) -> f64 {
    f0 * 2f64.powf(expected_offset_cents(vibrato, u) / 1200.0)
}

fn expected_offset_cents(vibrato: Option<Vibrato>, u: f64) -> f64 {
    vibrato.map_or(0.0, |v| v.depth_cents * (TAU * v.rate_hz * u).sin())
}

fn readings(generated: &Generated, sample_rate: f64, block_len: usize) -> Vec<PitchReading> {
    let mut maker = ReadingMaker::new(Mpm::new(), sample_rate);
    generated
        .samples
        .chunks(block_len)
        .filter_map(|block| maker.push_block(block))
        .collect()
}

/// Nearest-rank percentile of sorted values.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    sorted[rank - 1]
}

/// Pitch errors in cents of every reading whose window lies wholly after the onset.
fn pitch_errors(
    file: &CaseFile,
    signal: &Signal,
    generated: &Generated,
    readings: &[PitchReading],
    sample_rate: f64,
    centre_shift: i64,
) -> Vec<f64> {
    let midi = signal.midi.expect("tones need a midi note");
    readings
        .iter()
        .filter(|r| r.end_frame - WINDOW_LEN as u64 >= generated.onset_frame)
        .map(|r| {
            let centre = r.window_centre_frame() as i64 + centre_shift;
            let u = (centre - generated.onset_frame as i64) as f64 / sample_rate;
            let expected = midi + expected_offset_cents(file.vibrato, u) / 100.0;
            r.pitch
                .map_or(f64::INFINITY, |p| 100.0 * (p - expected).abs())
        })
        .collect()
}

fn run(name: &str) {
    let file = load(name);
    let limits = &file.limits;
    assert!(!file.signals.is_empty(), "{name}: no signals");

    for &sample_rate in &file.sample_rates {
        let mut errors = Vec::new();
        for signal in &file.signals {
            let generated = generate(&file, signal, sample_rate);
            let readings = readings(&generated, sample_rate, file.block_len);
            let label = format!("{name} @ {sample_rate} Hz, {signal:?}");
            assert!(!readings.is_empty(), "{label}: no readings");

            if let Some(below) = limits.clarity_below {
                let worst = readings.iter().map(|r| r.clarity).fold(0.0, f64::max);
                assert!(worst < below, "{label}: clarity {worst} not below {below}");
            }

            for r in &readings {
                let start = r.end_frame - WINDOW_LEN as u64;
                let after_onset = r.end_frame.saturating_sub(generated.onset_frame.max(start));
                let p = after_onset as f64 / WINDOW_LEN as f64;
                let expected = match signal.level_dbfs {
                    Some(level) if p > 0.0 => level + 10.0 * p.log10(),
                    _ => SILENCE_DBFS,
                };
                if file.waveform == Waveform::Silence {
                    assert_eq!(r.loudness_dbfs, SILENCE_DBFS, "{label}");
                } else if let Some(tolerance) = limits.loudness_tolerance_db
                    && (p == 0.0 || p >= 0.25)
                {
                    let off = (r.loudness_dbfs - expected).abs();
                    assert!(
                        off <= tolerance,
                        "{label}: endFrame {} loudness {} expected {expected}",
                        r.end_frame,
                        r.loudness_dbfs
                    );
                }
            }

            if signal.midi.is_some() {
                errors.extend(pitch_errors(
                    &file,
                    signal,
                    &generated,
                    &readings,
                    sample_rate,
                    0,
                ));
            }
        }

        if let (Some(median_max), Some(p99_max)) = (limits.median_cents_max, limits.p99_cents_max) {
            assert!(!errors.is_empty(), "{name}: no pitched readings");
            errors.sort_by(f64::total_cmp);
            let median = percentile(&errors, 50.0);
            let p99 = percentile(&errors, 99.0);
            println!(
                "{name} @ {sample_rate} Hz: {} readings, median {median:.2}, p99 {p99:.2} cents",
                errors.len()
            );
            assert!(
                median < median_max,
                "{name} @ {sample_rate} Hz: median {median} cents"
            );
            assert!(p99 <= p99_max, "{name} @ {sample_rate} Hz: p99 {p99} cents");
        }
    }
}

#[test]
fn sines_from_c2_to_c6() {
    run("sine");
}

#[test]
fn sines_with_vibrato() {
    run("sine-vibrato");
}

#[test]
fn sawtooth_tones_from_c2_to_c6() {
    run("sawtooth");
}

#[test]
fn sawtooth_tones_with_vibrato() {
    run("sawtooth-vibrato");
}

#[test]
fn tones_after_an_onset() {
    run("onset");
}

#[test]
fn noise_stays_unclear() {
    run("noise");
}

#[test]
fn silence_stays_unclear_and_reads_minus_120_dbfs() {
    run("silence");
}

#[test]
fn every_case_file_is_run() {
    let mut names: Vec<String> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures/detector")
        .filter_map(|e| {
            let path = e.ok()?.path();
            (path.extension()? == "json").then(|| path.file_stem()?.to_str().map(str::to_owned))?
        })
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "noise",
            "onset",
            "sawtooth",
            "sawtooth-vibrato",
            "silence",
            "sine",
            "sine-vibrato"
        ],
        "add a #[test] for each new case file"
    );
}

/// Each reading's window centre matches the signal's timing: with vibrato, the
/// pitch error is smallest when readings are compared at `endFrame − 1024`,
/// and clearly worse a quarter of a window either side.
#[test]
fn readings_are_stamped_at_their_window_centre() {
    let file = load("sine-vibrato");
    for &sample_rate in &file.sample_rates {
        let median_at = |shift: i64| {
            let mut errors: Vec<f64> = file
                .signals
                .iter()
                .flat_map(|signal| {
                    let generated = generate(&file, signal, sample_rate);
                    let readings = readings(&generated, sample_rate, file.block_len);
                    pitch_errors(&file, signal, &generated, &readings, sample_rate, shift)
                })
                .collect();
            errors.sort_by(f64::total_cmp);
            percentile(&errors, 50.0)
        };
        let centred = median_at(0);
        for shift in [-512, 512] {
            let shifted = median_at(shift);
            assert!(
                shifted > 2.0 * centred,
                "{sample_rate} Hz: shift {shift}: {shifted} vs {centred}"
            );
        }
    }
}

/// The committed native readings the WASM build is compared with in Vitest
/// (`web/src/pitch/worklet/pitchProcessor.test.ts`).
fn native_readings_path() -> PathBuf {
    fixtures_dir().join("native/readings.json")
}

/// FNV-1a (32-bit) over each sample's little-endian `f32` bytes: shows that
/// the TypeScript generator made the very same input.
fn samples_digest(samples: &[f32]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for sample in samples {
        for byte in sample.to_le_bytes() {
            hash ^= u32::from(byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
    }
    hash
}

/// The first signal of every case file at every rate: the digest of its
/// samples and the native readings, `[pitch | null, clarity, loudness, endFrame]`.
fn native_readings() -> serde_json::Value {
    let mut names: Vec<String> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures/detector")
        .filter_map(|e| {
            let path = e.ok()?.path();
            (path.extension()? == "json").then(|| path.file_stem()?.to_str().map(str::to_owned))?
        })
        .collect();
    names.sort();
    let mut runs = Vec::new();
    for name in names {
        let file = load(&name);
        let signal = &file.signals[0];
        for &sample_rate in &file.sample_rates {
            let generated = generate(&file, signal, sample_rate);
            let readings: Vec<serde_json::Value> =
                readings(&generated, sample_rate, file.block_len)
                    .iter()
                    .map(|r| serde_json::json!([r.pitch, r.clarity, r.loudness_dbfs, r.end_frame]))
                    .collect();
            runs.push(serde_json::json!({
                "case": name,
                "signal": 0,
                "sampleRate": sample_rate,
                "samplesDigest": samples_digest(&generated.samples),
                "readings": readings,
            }));
        }
    }
    serde_json::json!({
        "description": "Native readings of the first signal of every case file, made by `native_readings_file_is_current` in crates/detector/tests/fixtures.rs. Regenerate with OPENSTAR_UPDATE_NATIVE_READINGS=1 cargo test -p openstar-detector --test fixtures.",
        "runs": runs,
    })
}

#[test]
fn native_readings_file_is_current() {
    let current = native_readings();
    let path = native_readings_path();
    if std::env::var_os("OPENSTAR_UPDATE_NATIVE_READINGS").is_some() {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let text = serde_json::to_string(&current).expect("json") + "\n";
        std::fs::write(&path, text).expect("write");
        return;
    }
    let committed: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    assert!(
        committed == current,
        "{} is out of date: rerun with OPENSTAR_UPDATE_NATIVE_READINGS=1 and commit it",
        path.display()
    );
}
