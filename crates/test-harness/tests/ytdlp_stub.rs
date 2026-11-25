//! The yt-dlp stub, found as `yt-dlp` through the PATH the app is given.

use std::process::{Command, Output, Stdio};
use std::time::Duration;

use openstar_test_harness::{YtDlpStub, YtDlpStubBehaviour};

fn yt_dlp(stub: &YtDlpStub, args: &[&str]) -> Output {
    Command::new("yt-dlp")
        .env("PATH", stub.path_env())
        .args(args)
        .output()
        .expect("yt-dlp is found on the stub's PATH")
}

fn stream_kinds(path: &std::path::Path) -> String {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(output.status.success(), "ffprobe {}", path.display());
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn records_the_arguments_of_every_call() {
    let stub = YtDlpStub::new();

    yt_dlp(&stub, &["--version"]);
    yt_dlp(
        &stub,
        &["-j", "https://example.invalid/watch?v=a b", "--no-playlist"],
    );

    assert_eq!(
        stub.calls(),
        vec![
            vec!["--version".to_owned()],
            vec![
                "-j".to_owned(),
                "https://example.invalid/watch?v=a b".to_owned(),
                "--no-playlist".to_owned()
            ],
        ]
    );
}

#[test]
fn writes_a_tiny_video_where_the_output_arguments_ask() {
    let stub = YtDlpStub::new();
    let target = tempfile::tempdir().unwrap();
    let home = target.path().to_str().unwrap();

    let output = yt_dlp(
        &stub,
        &[
            "-P",
            home,
            "-o",
            "video.%(ext)s",
            "-f",
            "bv*+ba",
            "https://example.invalid/v",
        ],
    );

    assert!(output.status.success(), "{output:?}");
    let video = target.path().join("video.mp4");
    let kinds = stream_kinds(&video);
    assert!(
        kinds.contains("video") && kinds.contains("audio"),
        "{kinds}"
    );
}

#[test]
fn writes_tiny_audio_when_asked_to_extract_audio() {
    let stub = YtDlpStub::new();
    let target = tempfile::tempdir().unwrap();
    let template = target.path().join("sub/song.%(ext)s");

    let output = yt_dlp(
        &stub,
        &[
            "-x",
            "--audio-format",
            "mp3",
            "-o",
            template.to_str().unwrap(),
            "https://example.invalid/a",
        ],
    );

    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        stream_kinds(&target.path().join("sub/song.mp3")).trim(),
        "audio"
    );
}

#[test]
fn dump_json_prints_one_line_per_url_and_writes_nothing() {
    let stub = YtDlpStub::new();
    let output = yt_dlp(
        &stub,
        &[
            "-j",
            "https://example.invalid/1",
            "https://example.invalid/2",
        ],
    );

    let lines: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["webpage_url"], "https://example.invalid/2");
}

#[test]
fn can_be_scripted_to_fail_for_some_calls() {
    let stub = YtDlpStub::new();
    stub.script(
        YtDlpStubBehaviour::Fail {
            exit_code: 1,
            message: "ERROR: HTTP Error 403: Forbidden".to_owned(),
        },
        2,
    );

    for _ in 0..2 {
        let failed = yt_dlp(&stub, &["-j", "https://example.invalid/v"]);
        assert_eq!(failed.status.code(), Some(1));
        assert_eq!(
            String::from_utf8_lossy(&failed.stderr).trim(),
            "ERROR: HTTP Error 403: Forbidden"
        );
    }
    assert!(
        yt_dlp(&stub, &["-j", "https://example.invalid/v"])
            .status
            .success()
    );
    assert_eq!(stub.calls().len(), 3, "failed calls are recorded too");
}

#[test]
fn can_be_scripted_to_hang_until_killed() {
    let stub = YtDlpStub::new();
    stub.script(YtDlpStubBehaviour::Hang, 1);

    let mut child = Command::new("yt-dlp")
        .env("PATH", stub.path_env())
        .arg("https://example.invalid/v")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(child.try_wait().unwrap().is_none(), "still running");
    child.kill().unwrap();
    child.wait().unwrap();

    assert_eq!(stub.calls().len(), 1);
    assert!(
        yt_dlp(&stub, &["--version"]).status.success(),
        "only the scripted call hangs"
    );
}
