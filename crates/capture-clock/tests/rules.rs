//! Rules the case files do not reach on their own.

use openstar_capture_clock::{FrameMapping, Pong, SenderSession};

/// 1024 frames at 48 kHz.
const HALF: f64 = 1024.0 / 48.0;

#[test]
fn a_frame_counter_that_goes_back_starts_the_mapping_again() {
    let mut mapping = FrameMapping::new();
    // Far along an old stream: frame 480000 (10 s) handled at 10005 ms, k = 5.
    assert_eq!(
        mapping.stamp(480_000.0, 48000.0, 10_005.0),
        Some(10_005.0 - HALF)
    );
    // A new stream whose counter is at 4800 (100 ms) at 20 s: k = 19903. With
    // the old k = 5 kept it would be stamped ~19.9 s early.
    let stamp = mapping.stamp(4800.0, 48000.0, 20_003.0).expect("stamp");
    assert!((stamp - (20_003.0 - HALF)).abs() < 1e-9, "{stamp}");
}

#[test]
fn a_new_sample_rate_starts_the_mapping_again() {
    let mut mapping = FrameMapping::new();
    mapping.stamp(4800.0, 48000.0, 105.0);
    // 44.1 kHz, frame 44100 (1000 ms) at 5000 ms: k = 4000, not the old 5.
    let stamp = mapping.stamp(44100.0, 44100.0, 5000.0).expect("stamp");
    assert!((stamp - (5000.0 - 1024.0 / 44.1)).abs() < 1e-9, "{stamp}");
}

#[test]
fn inputs_that_are_not_times_stamp_nothing_and_are_not_kept() {
    let mut mapping = FrameMapping::new();
    assert_eq!(mapping.stamp(f64::NAN, 48000.0, 1.0), None);
    assert_eq!(mapping.stamp(4800.0, 0.0, 1.0), None);
    assert_eq!(mapping.stamp(4800.0, 48000.0, f64::INFINITY), None);
    assert_eq!(mapping.stamp(4800.0, 48000.0, 107.0), Some(107.0 - HALF));
}

#[test]
fn a_dropped_reading_still_teaches_the_mapping() {
    let mut session = SenderSession::remote();
    session.start_capture(0.0);
    // Handled with the least delay (k = 1) but before any offset: dropped.
    assert_eq!(session.stamp(4800.0, 48000.0, 101.0), None);
    session.receive_pong(Pong {
        t0: 0.0,
        t1: 2.0,
        ts: 501.0,
        epoch: 1.0,
    });
    // k = 31 now, but the envelope keeps the dropped reading's k = 1.
    let stamp = session.stamp(9600.0, 48000.0, 231.0).expect("stamp");
    assert!(
        (stamp - (200.0 + 1.0 - HALF + 500.0)).abs() < 1e-9,
        "{stamp}"
    );
}

#[test]
fn starting_capture_again_keeps_the_offset() {
    let mut session = SenderSession::remote();
    session.start_capture(0.0);
    session.receive_pong(Pong {
        t0: 0.0,
        t1: 2.0,
        ts: 501.0,
        epoch: 1.0,
    });
    session.start_capture(1000.0);
    assert_eq!(session.offset_ms(), Some(500.0));
    assert_eq!(session.poll_ping(1000.0), Some(1000.0));
}
