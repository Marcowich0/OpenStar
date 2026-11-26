//! yt-dlp's self-update (#198) against a fake of its releases on GitHub:
//! nothing here downloads the real yt-dlp or reaches GitHub.
//!
//! OpenStar keeps its own yt-dlp in `/appdata/bin`, installed from the
//! latest release at start and on a schedule (daily; seconds in these tests)
//! only when its SHA-256 matches the release's `SHA2-256SUMS`. The resolver
//! runs that copy only when it still matches the recorded checksum and runs;
//! otherwise the image's copy on `PATH` (here the yt-dlp stub).

use std::path::{Path, PathBuf};
use std::time::Duration;

use openstar_test_harness::{
    FakeYtDlpReleases, STUB_SCRIPT, TestApp, TestAppBuilder, YtDlpStub, YtDlpStubBehaviour,
    read_ytdlp_calls,
};

const WAIT: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_millis(150);

fn builder(on_path: &YtDlpStub, releases: &FakeYtDlpReleases) -> TestAppBuilder {
    TestApp::builder()
        .ytdlp_stub(on_path)
        .ytdlp_releases(releases)
        .ytdlp_update_every(EVERY)
}

fn own_copy(app: &TestApp) -> PathBuf {
    app.appdata_dir().join("bin/yt-dlp")
}

/// A release binary that is the yt-dlp stub, marked so a test can tell it
/// from the copy installed before.
fn stub_release(mark: &str) -> String {
    format!("{STUB_SCRIPT}\n# release {mark}\n")
}

/// A release binary that leaves `marker` behind when it is run at all.
fn telltale_release(marker: &Path) -> String {
    format!("#!/bin/sh\ntouch '{}'\necho 2099.01.01\n", marker.display())
}

async fn details(app: &TestApp, url: &str) -> reqwest::Response {
    app.http()
        .get(app.url("/api/usdb/video-details"))
        .query(&[("url", url)])
        .send()
        .await
        .unwrap()
}

async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !done() {
        assert!(tokio::time::Instant::now() < deadline, "never: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn contents(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// The files in `appdata/bin` besides the stub's own bookkeeping.
fn bin_files(app: &TestApp) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(app.appdata_dir().join("bin"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| !matches!(name.as_str(), "calls" | "behaviours"))
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn at_start_the_latest_release_is_installed_and_then_used_for_lookups() {
    let on_path = YtDlpStub::new();
    let releases = FakeYtDlpReleases::start().await;
    releases.publish("2026.11.20", stub_release("2026.11.20"));
    let app = builder(&on_path, &releases)
        .ytdlp_update_every(Duration::from_secs(3600))
        .start()
        .await;

    let own = own_copy(&app);
    eventually("the release is installed", || {
        contents(&own).as_deref() == Some(stub_release("2026.11.20").as_str())
    })
    .await;
    assert_eq!(
        releases.checks(),
        1,
        "one check at start, the next in an hour"
    );

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    let own_calls = read_ytdlp_calls(own.parent().unwrap());
    assert_eq!(
        own_calls.last().unwrap().last().unwrap(),
        "https://example.invalid/v",
        "the lookup ran the installed copy: {own_calls:?}"
    );
    assert!(on_path.calls().is_empty(), "the image's copy never ran");
}

#[tokio::test]
async fn a_newer_release_is_installed_on_the_next_scheduled_check() {
    let on_path = YtDlpStub::new();
    let releases = FakeYtDlpReleases::start().await;
    releases.publish("2026.11.20", stub_release("2026.11.20"));
    let app = builder(&on_path, &releases).start().await;
    let own = own_copy(&app);
    eventually("the first release is installed", || {
        contents(&own).as_deref() == Some(stub_release("2026.11.20").as_str())
    })
    .await;

    releases.publish("2026.11.27", stub_release("2026.11.27"));
    eventually("the newer release is installed", || {
        contents(&own).as_deref() == Some(stub_release("2026.11.27").as_str())
    })
    .await;
    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    assert!(on_path.calls().is_empty(), "the image's copy never ran");
}

#[tokio::test]
async fn an_installed_copy_that_is_the_latest_is_not_downloaded_again() {
    let on_path = YtDlpStub::new();
    let releases = FakeYtDlpReleases::start().await;
    releases.publish("2026.11.20", stub_release("2026.11.20"));
    let app = builder(&on_path, &releases).start().await;

    eventually("three checks", || releases.checks() >= 3).await;
    assert_eq!(releases.binary_downloads(), 1);
    assert_eq!(bin_files(&app), ["yt-dlp", "yt-dlp.sha256"]);
}

#[tokio::test]
async fn a_binary_whose_checksum_does_not_match_is_never_installed_or_run() {
    let on_path = YtDlpStub::new();
    let releases = FakeYtDlpReleases::start().await;
    let marker_dir = tempfile::tempdir().unwrap();
    let marker = marker_dir.path().join("ran");
    let wrong = format!("{}  yt-dlp_linux\n", "ab".repeat(32));
    releases.publish_with_sums("2026.11.20", telltale_release(&marker), wrong);
    let folders = openstar_test_harness::AppFolders::new();
    YtDlpStub::install_own_copy(folders.appdata_dir()).unwrap();
    let before = contents(&folders.appdata_dir().join("bin/yt-dlp"));
    let app = builder(&on_path, &releases).folders(folders).start().await;

    // A check has ended once the next one starts.
    eventually("two checks", || releases.checks() >= 2).await;
    assert!(releases.binary_downloads() >= 1, "the binary was fetched");
    assert!(!marker.exists(), "the mismatching binary ran");
    assert_eq!(
        contents(&own_copy(&app)),
        before,
        "the own copy was replaced"
    );
    // The next check may be downloading right now; a rejected download
    // that stayed behind would never go away.
    eventually("nothing is left behind", || {
        bin_files(&app) == ["yt-dlp", "yt-dlp.sha256"]
    })
    .await;

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    assert!(
        on_path.calls().is_empty(),
        "the own copy still serves lookups"
    );
}

#[tokio::test]
async fn a_release_that_does_not_run_is_not_installed() {
    let on_path = YtDlpStub::new();
    let releases = FakeYtDlpReleases::start().await;
    releases.publish("2026.11.20", "#!/bin/sh\necho broken >&2\nexit 3\n");
    let app = builder(&on_path, &releases).start().await;

    eventually("two checks", || releases.checks() >= 2).await;
    assert!(releases.binary_downloads() >= 1);
    assert!(!own_copy(&app).exists(), "the broken binary was installed");

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    assert_eq!(
        on_path.calls().len(),
        1,
        "the image's copy served the lookup"
    );
}

#[tokio::test]
async fn the_image_copy_is_used_when_the_own_copy_fails_its_checksum() {
    let on_path = YtDlpStub::new();
    let folders = openstar_test_harness::AppFolders::new();
    let bin = YtDlpStub::install_own_copy(folders.appdata_dir()).unwrap();
    std::fs::write(bin.join("yt-dlp.sha256"), format!("{}\n", "0".repeat(64))).unwrap();
    // The update is on, but finds no release server (a closed port).
    let app = TestApp::builder()
        .ytdlp_stub(&on_path)
        .var("OPENSTAR_YTDLP_AUTOUPDATE", "true")
        .folders(folders)
        .start()
        .await;

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    assert!(read_ytdlp_calls(&bin).is_empty(), "the own copy was run");
    assert_eq!(on_path.calls().len(), 1);
}

#[tokio::test]
async fn a_running_lookup_keeps_its_yt_dlp_while_a_new_copy_is_swapped_in() {
    let on_path = YtDlpStub::new();
    // No release at first: the checks fail until one is published.
    let releases = FakeYtDlpReleases::start().await;
    let folders = openstar_test_harness::AppFolders::new();
    let bin = YtDlpStub::install_own_copy(folders.appdata_dir()).unwrap();
    // The first call is the resolver's `--version`, the second the lookup.
    std::fs::write(bin.join("behaviours"), "delay 0\ndelay 2\n").unwrap();
    let app = builder(&on_path, &releases).folders(folders).start().await;

    let lookup = {
        let http = app.http().clone();
        let url = app.url("/api/usdb/video-details");
        tokio::spawn(async move {
            http.get(url)
                .query(&[("url", "https://example.invalid/v")])
                .send()
                .await
                .unwrap()
                .status()
        })
    };
    eventually("the lookup runs the own copy", || {
        read_ytdlp_calls(&bin).len() >= 2
    })
    .await;

    releases.publish("2026.11.27", stub_release("2026.11.27"));
    let own = own_copy(&app);
    eventually("the new copy is swapped in", || {
        contents(&own).as_deref() == Some(stub_release("2026.11.27").as_str())
    })
    .await;
    assert_eq!(lookup.await.unwrap(), 200, "the running lookup finished");
    assert!(on_path.calls().is_empty());
}

#[tokio::test]
async fn with_autoupdate_off_no_check_is_made_and_the_image_copy_is_used() {
    let on_path = YtDlpStub::new();
    let releases = FakeYtDlpReleases::start().await;
    releases.publish("2026.11.20", stub_release("2026.11.20"));
    // A copy an earlier start installed, when the update was still on.
    let folders = openstar_test_harness::AppFolders::new();
    let bin = YtDlpStub::install_own_copy(folders.appdata_dir()).unwrap();
    let before = contents(&bin.join("yt-dlp"));
    let app = builder(&on_path, &releases)
        .var("OPENSTAR_YTDLP_AUTOUPDATE", "false")
        .folders(folders)
        .start()
        .await;

    tokio::time::sleep(EVERY * 5).await;
    assert!(releases.requests().is_empty(), "{:?}", releases.requests());
    assert_eq!(contents(&own_copy(&app)), before);
    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    assert_eq!(on_path.calls().len(), 1);
    assert!(read_ytdlp_calls(&bin).is_empty(), "the own copy was run");
}

#[tokio::test]
async fn update_failures_never_stop_the_server_or_a_lookup() {
    let on_path = YtDlpStub::new();
    on_path.script(YtDlpStubBehaviour::Delay(Duration::from_millis(500)), 1);
    let releases = FakeYtDlpReleases::start().await;
    releases.publish("2026.11.20", stub_release("2026.11.20"));
    releases.fail_with(Some(500));
    let app = builder(&on_path, &releases).start().await;

    let lookup = details(&app, "https://example.invalid/v");
    let (status, ()) = tokio::join!(
        lookup,
        eventually("three failed checks", || { releases.checks() >= 3 })
    );
    assert_eq!(status.status(), 200);
    let health = app.http().get(app.url("/healthz")).send().await.unwrap();
    assert!(health.status().is_success());
    assert!(!own_copy(&app).exists());

    // A later check succeeds once the release server is back.
    releases.fail_with(None);
    let own = own_copy(&app);
    eventually("the release is installed", || {
        contents(&own).as_deref() == Some(stub_release("2026.11.20").as_str())
    })
    .await;
}
