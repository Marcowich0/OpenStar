//! The USDB client against the fake USDB (#146): login, re-login, pacing,
//! the User-Agent, backoff and the status codes. No test reaches the real
//! USDB: every client here points at a `FakeUsdb` or a closed local port.

use std::sync::Arc;
use std::time::Duration;

use openstar::usdb::{UsdbClient, UsdbTimer, VirtualTimer};
use openstar::{Secret, UsdbCredentials};
use openstar_protocol::UserMessage;
use openstar_protocol::usdb::{UsdbState, UsdbStatus};
use openstar_test_harness::{
    FAKE_USDB_PASSWORD, FAKE_USDB_USERNAME, FakeUsdb, RecordedRequest, Scripted, TestApp,
};

fn fake_credentials() -> Option<UsdbCredentials> {
    credentials(FAKE_USDB_PASSWORD)
}

fn credentials(password: &str) -> Option<UsdbCredentials> {
    Some(UsdbCredentials {
        username: FAKE_USDB_USERNAME.to_owned(),
        password: Secret::new(password),
    })
}

/// A client on the fake whose waits take no real time; the timer records them.
fn virtual_client(usdb: &FakeUsdb) -> (UsdbClient, Arc<VirtualTimer>) {
    let timer = Arc::new(VirtualTimer::new());
    let client = UsdbClient::new(
        usdb.base_url(),
        fake_credentials(),
        timer.clone() as Arc<dyn UsdbTimer>,
    );
    (client, timer)
}

/// `link=<name>` of each request, or its path when it has none.
fn links(requests: &[RecordedRequest]) -> Vec<String> {
    requests
        .iter()
        .map(|r| {
            r.query_param("link")
                .map(str::to_owned)
                .unwrap_or_else(|| r.path.clone())
        })
        .collect()
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(FakeUsdb::default_fixtures().join(name)).unwrap()
}

#[tokio::test]
async fn without_credentials_the_status_is_credentials_missing_and_nothing_is_requested() {
    let usdb = FakeUsdb::start().await;
    let client = UsdbClient::new(usdb.base_url(), None, Arc::new(VirtualTimer::new()));

    assert_eq!(client.status(), UsdbState::CredentialsMissing);
    assert_eq!(client.check_login().await, UsdbState::CredentialsMissing);
    assert_eq!(
        client.detail_page(1).await,
        Err(UserMessage::UsdbCredentialsMissing)
    );
    assert_eq!(
        client.cover(1).await,
        Err(UserMessage::UsdbCredentialsMissing)
    );
    assert!(usdb.requests().is_empty());
}

#[tokio::test]
async fn the_login_posts_the_form_and_is_checked_on_the_profile_page() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);
    assert_eq!(client.status(), UsdbState::Checking);

    assert_eq!(client.check_login().await, UsdbState::LoggedIn);
    assert_eq!(client.status(), UsdbState::LoggedIn);

    let requests = usdb.requests();
    assert_eq!(links(&requests), ["login", "profil"]);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(
        requests[0].body,
        format!("user={FAKE_USDB_USERNAME}&pass={FAKE_USDB_PASSWORD}&login=Login")
    );
    assert_eq!(requests[1].method, "GET");
    assert_eq!(
        requests[1].cookie.as_deref(),
        Some("PHPSESSID=fake-usdb-session"),
        "the login cookie is sent back"
    );
}

#[tokio::test]
async fn a_login_usdb_does_not_accept_reports_login_failed() {
    let usdb = FakeUsdb::start().await;
    let client = UsdbClient::new(
        usdb.base_url(),
        credentials("not-the-password"),
        Arc::new(VirtualTimer::new()),
    );

    assert_eq!(client.check_login().await, UsdbState::LoginFailed);
    assert_eq!(client.status(), UsdbState::LoginFailed);
}

#[tokio::test]
async fn a_not_logged_in_page_logs_in_again_and_retries_the_request_once() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);
    client.check_login().await;
    usdb.script(Scripted::NotLoggedIn, 1);

    let page = client.song_list_page(0, "lastchange", "desc").await;

    assert_eq!(page, Ok(fixture("list.html")));
    assert_eq!(
        links(&usdb.requests()),
        ["login", "profil", "list", "login", "list"]
    );
}

#[tokio::test]
async fn a_second_not_logged_in_page_fails_without_a_third_try() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);
    client.check_login().await;
    // The text, the login again (its answer is not read) and the retry.
    usdb.script(Scripted::NotLoggedIn, 3);

    let page = client.song_text_page(1).await;

    assert_eq!(page, Err(UserMessage::UsdbNotLoggedIn));
    assert_eq!(
        links(&usdb.requests()),
        ["login", "profil", "gettxt", "login", "gettxt"]
    );
    assert_eq!(client.status(), UsdbState::LoginFailed);
}

#[tokio::test]
async fn a_detail_page_with_the_sentence_in_its_comment_form_is_not_a_not_logged_in_page() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);
    assert!(fixture("detail-1.html").contains("You are not logged in."));

    assert_eq!(client.detail_page(1).await, Ok(fixture("detail-1.html")));
    assert_eq!(links(&usdb.requests()), ["detail"], "no login was needed");
}

#[tokio::test]
async fn requests_that_need_the_login_log_in_first() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);

    client.song_text_page(1).await.unwrap();

    let requests = usdb.requests();
    assert_eq!(links(&requests), ["login", "gettxt"]);
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].query, "link=gettxt&id=1");
    assert_eq!(requests[1].body, "wd=1");
}

#[tokio::test]
async fn a_list_page_posts_100_rows_from_start_in_the_given_order() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);

    client
        .song_list_page(200, "lastchange", "desc")
        .await
        .unwrap();

    let list = &usdb.requests()[1];
    assert_eq!(list.method, "POST");
    assert_eq!(list.query, "link=list");
    assert_eq!(list.body, "limit=100&start=200&order=lastchange&ud=desc");
}

#[tokio::test]
async fn a_cover_usdb_does_not_have_is_none() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);

    assert_eq!(client.cover(1).await, Ok(None));
    assert_eq!(usdb.requests()[0].path, "/data/cover/1.jpg");
}

/// Real time: the fake records when each request arrived.
#[tokio::test]
async fn requests_are_one_at_a_time_at_least_a_second_apart_with_the_user_agent() {
    let usdb = FakeUsdb::start().await;
    let client = UsdbClient::with_system_timer(usdb.base_url(), fake_credentials());

    // All at once: login and profile, a list page, a text, a detail page and
    // a cover queue behind each other.
    let (check, list, text, detail, cover) = tokio::join!(
        client.check_login(),
        client.song_list_page(0, "lastchange", "desc"),
        client.song_text_page(1),
        client.detail_page(1),
        client.cover(1),
    );
    assert_eq!(check, UsdbState::LoggedIn);
    assert!(list.is_ok() && text.is_ok() && detail.is_ok() && cover.is_ok());

    let requests = usdb.requests();
    assert_eq!(requests.len(), 6, "{:?}", links(&requests));
    for pair in requests.windows(2) {
        let gap = pair[1].arrived - pair[0].arrived;
        assert!(
            gap >= Duration::from_secs(1),
            "{} then {} only {gap:?} apart",
            pair[0].query,
            pair[1].query
        );
    }
    let user_agent = format!("OpenStar/{}", openstar::BUILD_ID);
    for request in &requests {
        assert_eq!(request.user_agent.as_deref(), Some(user_agent.as_str()));
    }
}

#[tokio::test]
async fn a_429_with_retry_after_waits_that_long_before_trying_again() {
    let usdb = FakeUsdb::start().await;
    let (client, timer) = virtual_client(&usdb);
    usdb.script(
        Scripted::Error {
            status: 429,
            retry_after: Some(7),
        },
        1,
    );

    assert_eq!(client.detail_page(1).await, Ok(fixture("detail-1.html")));
    assert_eq!(timer.waits(), [Duration::from_secs(7)]);
    assert_eq!(links(&usdb.requests()), ["detail", "detail"]);
}

#[tokio::test]
async fn without_retry_after_the_wait_starts_at_5_s_and_doubles() {
    let usdb = FakeUsdb::start().await;
    let (client, timer) = virtual_client(&usdb);
    usdb.script(
        Scripted::Error {
            status: 503,
            retry_after: None,
        },
        4,
    );

    assert!(
        client.detail_page(1).await.is_ok(),
        "the fifth try succeeds"
    );
    let seconds: Vec<u64> = timer.waits().iter().map(Duration::as_secs).collect();
    assert_eq!(seconds, [5, 10, 20, 40]);
}

#[tokio::test]
async fn after_5_tries_it_gives_up_with_a_code() {
    let usdb = FakeUsdb::start().await;
    let (client, _) = virtual_client(&usdb);
    usdb.script(
        Scripted::Error {
            status: 502,
            retry_after: None,
        },
        5,
    );

    assert_eq!(
        client.detail_page(1).await,
        Err(UserMessage::UsdbGaveUp { status: 502 })
    );
    assert_eq!(usdb.requests().len(), 5);
    assert_eq!(client.status(), UsdbState::GaveUp);
}

#[tokio::test]
async fn while_it_backs_off_no_other_request_is_sent() {
    let usdb = FakeUsdb::start().await;
    let (client, timer) = virtual_client(&usdb);
    usdb.script(
        Scripted::Error {
            status: 500,
            retry_after: None,
        },
        2,
    );

    let (detail, cover) = tokio::join!(client.detail_page(1), client.cover(1));
    assert!(detail.is_ok() && cover.is_ok());

    let paths: Vec<String> = usdb.requests().iter().map(|r| r.path.clone()).collect();
    assert_eq!(
        paths,
        [
            "/index.php",
            "/index.php",
            "/index.php",
            "/data/cover/1.jpg"
        ],
        "the cover waited behind every retry of the detail page"
    );
    let seconds: Vec<u64> = timer.waits().iter().map(Duration::as_secs).collect();
    assert_eq!(seconds, [5, 10, 1], "then the cover keeps the pacing");
}

#[tokio::test]
async fn a_usdb_that_cannot_be_reached_reports_unreachable() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let client = UsdbClient::new(base_url, fake_credentials(), Arc::new(VirtualTimer::new()));

    assert_eq!(client.check_login().await, UsdbState::Unreachable);
    assert_eq!(
        client.detail_page(1).await,
        Err(UserMessage::UsdbUnreachable)
    );
    assert_eq!(client.status(), UsdbState::Unreachable);
}

#[tokio::test]
async fn the_server_reports_credentials_missing_without_contacting_usdb() {
    let app = TestApp::start().await;
    let status: UsdbStatus = app.get_json("/api/usdb/status").await;
    assert_eq!(status.state, UsdbState::CredentialsMissing);
}

#[tokio::test]
async fn the_server_logs_in_at_start_and_reports_logged_in() {
    let usdb = FakeUsdb::start().await;
    let app = TestApp::builder().usdb(&usdb).start().await;

    let mut state = UsdbState::Checking;
    for _ in 0..100 {
        state = app.get_json::<UsdbStatus>("/api/usdb/status").await.state;
        if state != UsdbState::Checking {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(state, UsdbState::LoggedIn);
    // The USDB mirror's first fill (#147) follows the login check.
    assert_eq!(links(&usdb.requests())[..2], ["login", "profil"]);

    // Nothing about the login is kept: no file in appdata holds the
    // password, the username or the session cookie.
    for entry in std::fs::read_dir(app.appdata_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let bytes = std::fs::read(&path).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            for secret in [FAKE_USDB_PASSWORD, FAKE_USDB_USERNAME, "fake-usdb-session"] {
                assert!(!text.contains(secret), "{} holds {secret}", path.display());
            }
        }
    }
}
