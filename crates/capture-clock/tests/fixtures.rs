//! Runs every case in `fixtures/capture-clock/` against the native build. The
//! WASM build runs the same files through the TypeScript wrapper
//! (`web/src/pitch/clock/senderSession.test.ts`); `fixtures/capture-clock/README.md`
//! defines the format.

use openstar_capture_clock::{Pong, SenderSession};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Expected stamps and offsets are written to 6 decimals.
const EXACT_MS: f64 = 1e-5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaseFile {
    #[allow(dead_code)]
    pub description: String,
    pub session: String,
    #[serde(default)]
    pub true_time_spread_max_ms: Option<f64>,
    pub steps: Vec<Vec<Value>>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/capture-clock")
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn opt(v: &Value) -> Option<f64> {
    if v.is_null() { None } else { Some(num(v)) }
}

fn assert_opt(at: &str, got: Option<f64>, want: Option<f64>) {
    match (got, want) {
        (None, None) => {}
        (Some(g), Some(w)) => assert!((g - w).abs() <= EXACT_MS, "{at}: got {g}, want {w}"),
        _ => panic!("{at}: got {got:?}, want {want:?}"),
    }
}

/// Runs one case file; panics on the first step that disagrees.
fn run(name: &str) {
    let path = fixtures_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{name}: {e}"));
    let case: CaseFile = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
    let mut session = match case.session.as_str() {
        "remote" => SenderSession::remote(),
        "local" => SenderSession::local(),
        other => panic!("{name}: unknown session {other}"),
    };
    let mut sample_rate = f64::NAN;
    let mut true_errors: Vec<f64> = Vec::new();
    for (i, step) in case.steps.iter().enumerate() {
        let at = format!("{name} step {i} {step:?}");
        let op = step[0].as_str().expect("step name");
        match op {
            "start" => {
                session.start_capture(num(&step[1]));
                sample_rate = num(&step[2]);
            }
            "stop" => session.stop_capture(),
            "restartSync" => session.restart_sync(num(&step[1])),
            "ping" => assert_opt(&at, session.poll_ping(num(&step[1])), opt(&step[2])),
            "nextPing" => assert_opt(&at, session.next_ping_at(), opt(&step[1])),
            "offset" => assert_opt(&at, session.offset_ms(), opt(&step[1])),
            "pong" => session.receive_pong(Pong {
                t0: num(&step[1]),
                t1: num(&step[2]),
                ts: num(&step[3]),
                epoch: num(&step[4]),
            }),
            "reading" => {
                let got = session.stamp(num(&step[1]), sample_rate, num(&step[2]));
                assert_opt(&at, got, opt(&step[3]));
                if let (Some(stamp), Some(truth)) = (got, step.get(4).and_then(opt)) {
                    true_errors.push(stamp - truth);
                }
            }
            other => panic!("{at}: unknown step {other}"),
        }
    }
    if !true_errors.is_empty() {
        let lo = true_errors.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = true_errors
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        eprintln!(
            "{name}: stamp − true {lo:.3}..{hi:.3} ms (spread {:.3})",
            hi - lo
        );
    }
    if let Some(max) = case.true_time_spread_max_ms {
        assert!(
            !true_errors.is_empty(),
            "{name}: no reading has a true time"
        );
        let lo = true_errors.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = true_errors
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            hi - lo <= max,
            "{name}: stamp − true capture time spreads {lo:.3}..{hi:.3} ms, more than {max} ms"
        );
    }
}

#[test]
fn local_mics() {
    run("local-mics.json");
}

#[test]
fn stale_pong() {
    run("stale-pong.json");
}

#[test]
fn ping_schedule() {
    run("ping-schedule.json");
}

// ---------------------------------------------------------------------------
// The synthetic streams. Each generated file is made here from a model of the
// device (an audio clock that may run slow, main-thread delay, bursts, a Stage
// clock with an offset and drift, uneven network delays) and a naive
// reference of the spec's rules, independent of the crate's ring buffers. The
// files are committed so the WASM build runs the very same cases;
// `generated_files_are_current` fails when this model and the files differ
// (write them with `OPENSTAR_UPDATE_CLOCK_FIXTURES=1`).

#[path = "support/generate.rs"]
mod generate;

#[test]
fn generated_files_are_current() {
    let update = std::env::var_os("OPENSTAR_UPDATE_CLOCK_FIXTURES").is_some();
    for (name, text) in generate::all() {
        let path = fixtures_dir().join(&name);
        if update {
            std::fs::write(&path, &text).expect("write fixture");
            continue;
        }
        let committed: Value = serde_json::from_str(
            &std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("{name}: {e} (OPENSTAR_UPDATE_CLOCK_FIXTURES=1)")),
        )
        .expect("committed JSON");
        let made: Value = serde_json::from_str(&text).expect("generated JSON");
        assert!(
            committed == made,
            "{name} is not what the generator makes: OPENSTAR_UPDATE_CLOCK_FIXTURES=1 cargo test -p openstar-capture-clock --test fixtures"
        );
    }
}

#[test]
fn every_case_file_is_run() {
    let mut run_here: Vec<String> = generate::all().into_iter().map(|(n, _)| n).collect();
    run_here.extend([
        "local-mics.json".into(),
        "ping-schedule.json".into(),
        "stale-pong.json".into(),
    ]);
    for entry in std::fs::read_dir(fixtures_dir()).expect("fixtures dir") {
        let name = entry
            .expect("entry")
            .file_name()
            .to_string_lossy()
            .into_owned();
        if name.ends_with(".json") {
            assert!(
                run_here.contains(&name),
                "{name} is not run by tests/fixtures.rs"
            );
        }
    }
}

#[test]
fn generated_cases() {
    let failed: Vec<String> = generate::all()
        .into_iter()
        .filter(|(name, _)| std::panic::catch_unwind(|| run(name)).is_err())
        .map(|(name, _)| name)
        .collect();
    assert!(failed.is_empty(), "failed: {failed:?}");
}
