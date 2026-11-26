//! yt-dlp's progress lines as a Download reads them.
//!
//! A Download runs yt-dlp with `--newline` and [`PROGRESS_TEMPLATE`], so each
//! progress update is one line of stdout, `<percent>|<speed>|<eta>`, for
//! example ` 50.0%| 12.34MiB/s|00:01`. Every other line (`[download]
//! Destination: ...`, `[Merger] ...`) is not progress. yt-dlp writes
//! `Unknown` (or `NA`) where it does not know a value yet.

use serde::Deserialize;

/// yt-dlp's `--progress-template`: only download progress, as
/// `percent|speed|eta`.
pub(crate) const PROGRESS_TEMPLATE: &str =
    "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s";

/// One progress line, read.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressLine {
    /// How far the file being downloaded is, from 0 to 100.
    pub(crate) percent: f32,
    pub(crate) bytes_per_second: Option<u64>,
    pub(crate) eta_seconds: Option<u32>,
}

/// Reads one line of yt-dlp's stdout; `None` when it is not a progress line.
pub(crate) fn parse_progress_line(line: &str) -> Option<ProgressLine> {
    let line = strip_ansi(line);
    let mut fields = line.split('|');
    let (percent, speed, eta) = (fields.next()?, fields.next()?, fields.next()?);
    if fields.next().is_some() {
        return None;
    }
    let percent: f32 = percent.trim().strip_suffix('%')?.trim().parse().ok()?;
    if !(0.0..=100.0).contains(&percent) {
        return None;
    }
    Some(ProgressLine {
        percent,
        bytes_per_second: parse_speed(speed.trim()),
        eta_seconds: parse_eta(eta.trim()),
    })
}

/// `12.34MiB/s` → bytes per second, rounded down; `None` for `Unknown B/s`.
fn parse_speed(speed: &str) -> Option<u64> {
    let amount = speed.strip_suffix("/s")?;
    let split = amount.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    let (number, unit) = amount.split_at(split);
    let number: f64 = number.parse().ok()?;
    let scale: f64 = match unit {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    let bytes = (number * scale).floor();
    // Never negative (the number has no sign); far below u64::MAX.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a finite, non-negative speed far below u64::MAX"
    )]
    (bytes.is_finite() && bytes < 1e18).then_some(bytes as u64)
}

/// `00:42`, `01:02:03` → seconds; `None` for `Unknown`.
fn parse_eta(eta: &str) -> Option<u32> {
    let mut seconds: u32 = 0;
    let mut parts = 0;
    for part in eta.split(':') {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(part.parse().ok()?)?;
        parts += 1;
    }
    (2..=3).contains(&parts).then_some(seconds)
}

/// The line without ANSI colour codes (`ESC [ ... m`), in case yt-dlp
/// colours its output.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/ytdlp")
                .join(name),
        )
        .unwrap()
    }

    #[derive(Deserialize)]
    struct Expected {
        events: Vec<ProgressLine>,
    }

    #[test]
    fn recorded_output_gives_one_event_per_progress_line() {
        let output = fixture("download-progress.txt");
        let expected: Expected = serde_json::from_str(&fixture("download-progress.json")).unwrap();
        let events: Vec<ProgressLine> = output.lines().filter_map(parse_progress_line).collect();
        assert_eq!(events, expected.events);
    }

    #[test]
    fn coloured_and_odd_lines() {
        assert_eq!(
            parse_progress_line(
                "\u{1b}[0;94m 42.0%\u{1b}[0m|\u{1b}[0;32m  1.00KiB/s\u{1b}[0m|00:05"
            ),
            Some(ProgressLine {
                percent: 42.0,
                bytes_per_second: Some(1024),
                eta_seconds: Some(5),
            })
        );
        assert_eq!(parse_progress_line("[download] 100% of 1.00KiB"), None);
        assert_eq!(parse_progress_line("a|b|c"), None);
        assert_eq!(parse_progress_line("150%|1B/s|00:00"), None);
        assert_eq!(parse_progress_line("5%|1B/s|00:00|x"), None);
    }
}
