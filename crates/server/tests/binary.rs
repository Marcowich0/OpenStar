//! The `openstar` binary as the operator runs it: configuration errors,
//! startup logs on stdout, and `openstar healthcheck`.

use std::io::Read;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_openstar");
const PIN: &str = "975318";
const USDB_PASSWORD: &str = "correct-horse-battery";

/// The binary with an empty environment apart from `vars`.
fn openstar(args: &[&str], vars: &[(&str, &str)]) -> Command {
    let mut command = Command::new(BINARY);
    command.args(args).env_clear().envs(vars.iter().copied());
    command
}

fn run(args: &[&str], vars: &[(&str, &str)]) -> Output {
    openstar(args, vars).output().unwrap()
}

fn all_output(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn healthcheck(port: u16) -> bool {
    run(&["healthcheck"], &[("OPENSTAR_PORT", &port.to_string())])
        .status
        .success()
}

/// Starts the server and waits until `openstar healthcheck` passes.
fn start_server(vars: &[(&str, &str)], port: u16) -> Child {
    let mut child = openstar(&[], vars)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !healthcheck(port) {
        if let Some(status) = child.try_wait().unwrap() {
            let mut out = String::new();
            child
                .stdout
                .take()
                .unwrap()
                .read_to_string(&mut out)
                .unwrap();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut out)
                .unwrap();
            panic!("the server exited with {status}: {out}");
        }
        assert!(Instant::now() < deadline, "the server never became healthy");
        std::thread::sleep(Duration::from_millis(50));
    }
    child
}

fn stop(mut child: Child) -> String {
    child.kill().unwrap();
    all_output(&child.wait_with_output().unwrap())
}

fn dirs(appdata: &Path, songs: &Path) -> [(&'static str, String); 2] {
    [
        ("OPENSTAR_APPDATA_DIR", appdata.display().to_string()),
        ("OPENSTAR_SONGS_DIR", songs.display().to_string()),
    ]
}

#[test]
fn a_missing_admin_pin_exits_with_a_clear_message() {
    let output = run(&[], &[]);
    assert!(!output.status.success());
    let text = all_output(&output);
    assert!(text.contains("OPENSTAR_ADMIN_PIN is not set"), "{text}");
}

#[test]
fn a_malformed_admin_pin_exits_without_repeating_it() {
    let output = run(&[], &[("OPENSTAR_ADMIN_PIN", "12ab")]);
    assert!(!output.status.success());
    let text = all_output(&output);
    assert!(text.contains("4 to 8 digits"), "{text}");
    assert!(!text.contains("12ab"), "{text}");
}

#[test]
fn a_variable_and_its_file_variant_exit_naming_both() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("pin");
    std::fs::write(&file, "1234").unwrap();
    let output = run(
        &[],
        &[
            ("OPENSTAR_ADMIN_PIN", "1234"),
            ("OPENSTAR_ADMIN_PIN_FILE", file.to_str().unwrap()),
        ],
    );
    assert!(!output.status.success());
    let text = all_output(&output);
    assert!(
        text.contains("both OPENSTAR_ADMIN_PIN and OPENSTAR_ADMIN_PIN_FILE are set"),
        "{text}"
    );
}

#[test]
fn a_missing_appdata_folder_exits_with_a_clear_message() {
    let songs = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let [appdata_var, songs_var] = dirs(&parent.path().join("absent"), songs.path());
    let output = run(
        &[],
        &[
            ("OPENSTAR_ADMIN_PIN", PIN),
            (appdata_var.0, &appdata_var.1),
            (songs_var.0, &songs_var.1),
            ("OPENSTAR_PORT", &free_port().to_string()),
        ],
    );
    assert!(!output.status.success());
    let text = all_output(&output);
    assert!(text.contains("appdata folder"), "{text}");
}

#[test]
fn startup_runs_in_order_and_logs_plain_text_without_secrets() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let secrets = tempfile::tempdir().unwrap();
    let pin_file = secrets.path().join("pin");
    std::fs::write(&pin_file, format!("{PIN}\n")).unwrap();
    let port = free_port();
    let [appdata_var, songs_var] = dirs(appdata.path(), songs.path());
    let child = start_server(
        &[
            ("OPENSTAR_ADMIN_PIN_FILE", pin_file.to_str().unwrap()),
            ("OPENSTAR_USDB_USERNAME", "singer"),
            ("OPENSTAR_USDB_PASSWORD", USDB_PASSWORD),
            ("OPENSTAR_LOG", "trace"),
            ("OPENSTAR_PORT", &port.to_string()),
            (appdata_var.0, &appdata_var.1),
            (songs_var.0, &songs_var.1),
        ],
        port,
    );
    let logs = stop(child);

    assert!(!logs.contains('\u{1b}'), "no colour codes in the logs");
    assert!(!logs.contains(PIN), "the Admin PIN is logged:\n{logs}");
    assert!(
        !logs.contains(USDB_PASSWORD),
        "the USDB password is logged:\n{logs}"
    );
    assert!(
        logs.contains("TRACE") || logs.contains("DEBUG"),
        "OPENSTAR_LOG=trace applies"
    );

    let steps = [
        "configuration read",
        "the appdata folder is writable",
        "the database is ready",
        "the songs folder is writable",
        "live state reloaded",
        "OpenStar is serving",
    ];
    let positions: Vec<usize> = steps
        .iter()
        .map(|step| {
            logs.find(step)
                .unwrap_or_else(|| panic!("no {step:?} in the logs:\n{logs}"))
        })
        .collect();
    assert!(
        positions.windows(2).all(|w| w[0] < w[1]),
        "startup steps out of order:\n{logs}"
    );
    let serving = logs
        .lines()
        .find(|l| l.contains("OpenStar is serving"))
        .unwrap();
    assert!(serving.contains(openstar::BUILD_ID), "{serving}");
}

#[test]
fn the_default_log_level_is_info() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let port = free_port();
    let [appdata_var, songs_var] = dirs(appdata.path(), songs.path());
    let child = start_server(
        &[
            ("OPENSTAR_ADMIN_PIN", PIN),
            ("OPENSTAR_PORT", &port.to_string()),
            (appdata_var.0, &appdata_var.1),
            (songs_var.0, &songs_var.1),
        ],
        port,
    );
    let logs = stop(child);
    assert!(logs.contains(" INFO "), "{logs}");
    assert!(!logs.contains("DEBUG") && !logs.contains("TRACE"), "{logs}");
}

#[test]
fn healthcheck_fails_when_nothing_answers() {
    assert!(!healthcheck(free_port()));
}

#[test]
fn healthcheck_fails_when_healthz_does_not_answer_success() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        use std::io::Write;
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut buffer = [0; 1024];
            let _ = stream.read(&mut buffer);
            let _ =
                stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
        }
    });
    assert!(!healthcheck(port));
}

#[test]
fn version_prints_the_build_identifier() {
    let output = run(&["--version"], &[]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        openstar::BUILD_ID
    );
}
