//! The fake USDB: saved pages, recorded requests and scripted failures.

use std::time::Duration;

use openstar_test_harness::{FAKE_USDB_PASSWORD, FAKE_USDB_USERNAME, FakeUsdb, Scripted};

fn fixture(name: &str) -> String {
    std::fs::read_to_string(FakeUsdb::default_fixtures().join(name)).unwrap()
}

async fn get(url: String) -> reqwest::Response {
    reqwest::get(url).await.unwrap()
}

#[tokio::test]
async fn serves_saved_pages_from_the_fixtures_folder() {
    let usdb = FakeUsdb::start().await;
    let base = usdb.base_url();

    let detail = get(format!("{base}/index.php?link=detail&id=1")).await;
    assert_eq!(detail.status(), 200);
    assert_eq!(detail.text().await.unwrap(), fixture("detail-1.html"));

    // No page for this id: the page for the link answers.
    let other = get(format!("{base}/index.php?link=list&id=99")).await;
    assert_eq!(other.text().await.unwrap(), fixture("list.html"));

    let home = get(format!("{base}/")).await;
    assert_eq!(home.text().await.unwrap(), fixture("home.html"));

    assert_eq!(
        get(format!("{base}/index.php?link=nope")).await.status(),
        404
    );
    assert_eq!(get(format!("{base}/data/cover/1.jpg")).await.status(), 404);
}

#[tokio::test]
async fn records_each_requests_path_query_body_and_arrival_time() {
    let usdb = FakeUsdb::start().await;
    let base = usdb.base_url();

    get(format!("{base}/index.php?link=list")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    reqwest::Client::new()
        .post(format!("{base}/index.php?link=gettxt&id=1"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body("wd=1")
        .send()
        .await
        .unwrap();

    let requests = usdb.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/index.php");
    assert_eq!(requests[0].query, "link=list");
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].query_param("link"), Some("gettxt"));
    assert_eq!(requests[1].query_param("id"), Some("1"));
    assert_eq!(requests[1].body, "wd=1");
    assert!(
        requests[1].arrived >= requests[0].arrived + Duration::from_millis(50),
        "arrival times are kept: {requests:?}"
    );
}

#[tokio::test]
async fn can_be_scripted_to_answer_an_error_with_retry_after_for_some_requests() {
    let usdb = FakeUsdb::start().await;
    let url = format!("{}/index.php?link=list", usdb.base_url());
    usdb.script(
        Scripted::Error {
            status: 429,
            retry_after: Some(3),
        },
        2,
    );

    for _ in 0..2 {
        let response = get(url.clone()).await;
        assert_eq!(response.status(), 429);
        assert_eq!(response.headers()["retry-after"], "3");
    }
    let response = get(url).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), fixture("list.html"));
    assert_eq!(
        usdb.requests().len(),
        3,
        "scripted requests are recorded too"
    );
}

#[tokio::test]
async fn can_be_scripted_to_answer_the_not_logged_in_page() {
    let usdb = FakeUsdb::start().await;
    let url = format!("{}/index.php?link=detail&id=1", usdb.base_url());
    usdb.script(Scripted::NotLoggedIn, 1);
    usdb.script(
        Scripted::Error {
            status: 503,
            retry_after: None,
        },
        1,
    );

    let first = get(url.clone()).await;
    assert_eq!(first.status(), 200);
    assert_eq!(first.text().await.unwrap(), fixture("not-logged-in.html"));
    let second = get(url.clone()).await;
    assert_eq!(second.status(), 503);
    assert!(second.headers().get("retry-after").is_none());
    assert_eq!(
        get(url).await.text().await.unwrap(),
        fixture("detail-1.html")
    );
}

#[tokio::test]
async fn path_traversal_does_not_leave_the_fixtures_folder() {
    let usdb = FakeUsdb::start().await;
    let base = usdb.base_url();
    for path in [
        "/../README.md",
        "/%2e%2e/README.md",
        "/index.php?link=../README",
    ] {
        assert_eq!(get(format!("{base}{path}")).await.status(), 404, "{path}");
    }
}

async fn log_in(base: &str, user: &str, pass: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{base}/index.php?link=login"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(format!("user={user}&pass={pass}&login=Login"))
        .send()
        .await
        .unwrap()
}

async fn profile_with(base: &str, cookie: Option<&str>) -> String {
    let mut request = reqwest::Client::new().get(format!("{base}/index.php?link=profil"));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    request.send().await.unwrap().text().await.unwrap()
}

#[tokio::test]
async fn a_login_with_the_fake_credentials_gets_a_session_cookie_for_the_profile_page() {
    let usdb = FakeUsdb::start().await;
    let base = usdb.base_url();

    let login = log_in(&base, FAKE_USDB_USERNAME, FAKE_USDB_PASSWORD).await;
    let cookie = login.headers()["set-cookie"].to_str().unwrap().to_owned();
    let cookie = cookie.split(';').next().unwrap();
    assert_eq!(login.text().await.unwrap(), fixture("home.html"));

    assert_eq!(
        profile_with(&base, Some(cookie)).await,
        fixture("profil.html")
    );
    assert_eq!(
        profile_with(&base, None).await,
        fixture("logged-out/profil.html"),
        "without the cookie the profile page shows no login"
    );
}

#[tokio::test]
async fn a_login_with_other_credentials_gets_no_session_cookie() {
    let usdb = FakeUsdb::start().await;
    let base = usdb.base_url();

    let login = log_in(&base, FAKE_USDB_USERNAME, "wrong").await;
    assert!(login.headers().get("set-cookie").is_none());
    assert_eq!(
        profile_with(&base, Some("PHPSESSID=guessed")).await,
        fixture("logged-out/profil.html")
    );
}

#[tokio::test]
async fn records_each_requests_user_agent_and_cookie() {
    let usdb = FakeUsdb::start().await;
    reqwest::Client::new()
        .get(format!("{}/index.php?link=detail&id=1", usdb.base_url()))
        .header("user-agent", "Tester/1")
        .header("cookie", "a=b")
        .send()
        .await
        .unwrap();
    get(usdb.base_url()).await;

    let requests = usdb.requests();
    assert_eq!(requests[0].user_agent.as_deref(), Some("Tester/1"));
    assert_eq!(requests[0].cookie.as_deref(), Some("a=b"));
    assert_eq!(requests[1].cookie, None);
}
