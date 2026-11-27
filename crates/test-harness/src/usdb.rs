//! A fake USDB: a local HTTP server that serves saved pages from
//! `fixtures/usdb/`, records every request and can be scripted to fail.
//!
//! How a request finds its page (see `fixtures/usdb/README.md`):
//!
//! - `/` or `/index.php` with `link=<name>` and `id=<n>` in the query:
//!   `<name>-<n>.html`, else `<name>.html`; without `link`, `home.html`.
//! - any other path: the file at that path below `static/`.
//! - nothing found: 404.
//!
//! Logins: `POST ?link=login` with the fake credentials (`user`, `pass`)
//! answers with the session cookie [`SESSION_COOKIE`]; with any other
//! credentials it answers without one. `?link=profil` without that cookie
//! serves `logged-out/profil.html`. Every other page is served whatever the
//! cookie.
//!
//! The control endpoints under `/__fake/` let a standalone fake (for
//! `just e2e`) be read and scripted over HTTP: `GET /__fake/requests` returns
//! the recorded requests, `POST /__fake/script` with a [`ScriptEntry`] queues a
//! scripted answer, `POST /__fake/songs` with a JSON list of [`FakeSong`]s is
//! [`FakeUsdb::set_songs`], and `PUT /__fake/covers/<id>` with the image bytes
//! is [`FakeUsdb::set_cover`]. Control requests are not recorded.
//!
//! Covers: `GET /data/cover/<id>.jpg` answers a cover given with
//! [`FakeUsdb::set_cover`] (as `image/jpeg`, even when empty), else the file
//! below `static/`, else 404 (USDB has no cover).

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

/// The page served for [`Scripted::NotLoggedIn`], inside the fixtures folder.
pub const NOT_LOGGED_IN_PAGE: &str = "not-logged-in.html";

/// The profile page served to a request without the fake's session cookie.
pub const LOGGED_OUT_PROFILE_PAGE: &str = "logged-out/profil.html";

/// The session cookie a login with the fake credentials gets back
/// (`Set-Cookie`), and that `?link=profil` asks for.
pub const SESSION_COOKIE: &str = "PHPSESSID=fake-usdb-session";

/// One request the fake received.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    /// The raw query string, without the `?`; empty when there was none.
    pub query: String,
    /// The request body as text (a form body for POSTs).
    pub body: String,
    /// The `User-Agent` header, when sent.
    #[serde(default)]
    pub user_agent: Option<String>,
    /// The `Cookie` header, when sent.
    #[serde(default)]
    pub cookie: Option<String>,
    /// When it arrived, measured from the fake's start.
    #[serde(rename = "arrivedMs", with = "millis")]
    pub arrived: Duration,
}

impl RecordedRequest {
    /// The value of `name` in the query string, if present (not URL-decoded).
    pub fn query_param(&self, name: &str) -> Option<&str> {
        query_param(&self.query, name)
    }
}

/// A scripted answer that replaces the saved page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Scripted {
    /// An error status, with a `Retry-After` header in seconds when given.
    Error {
        status: u16,
        retry_after: Option<u64>,
    },
    /// The "not logged in" page, with status 200 as USDB sends it.
    NotLoggedIn,
    /// The answer the fake would give without a script: to let some requests
    /// through before the scripted ones.
    Page,
}

/// A scripted answer for the next `times` requests: the body of
/// `POST /__fake/script`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub times: usize,
    pub response: Scripted,
}

/// One song of the fake's song list (see [`FakeUsdb::set_songs`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeSong {
    pub id: u32,
    pub artist: String,
    pub title: String,
    pub genre: String,
    pub year: Option<u16>,
    pub edition: String,
    pub golden: bool,
    pub language: String,
    pub creator: String,
    /// The rating in half stars, 0 to 10.
    pub half_stars: u8,
    pub views: u32,
    /// USDB's last change, in Unix seconds.
    pub last_change: i64,
}

impl FakeSong {
    /// A song with placeholder values for every other field.
    pub fn new(id: u32, artist: &str, title: &str, last_change: i64) -> Self {
        Self {
            id,
            artist: artist.to_owned(),
            title: title.to_owned(),
            genre: "Pop".to_owned(),
            year: Some(2001),
            edition: String::new(),
            golden: false,
            language: "English".to_owned(),
            creator: "placeholder-creator".to_owned(),
            half_stars: 6,
            views: id * 10,
            last_change,
        }
    }

    /// `count` songs with ids from `first_id`, each changed one second
    /// before the one before it, starting at `newest_change`.
    pub fn many(first_id: u32, count: u32, newest_change: i64) -> Vec<Self> {
        (0..count)
            .map(|i| {
                let id = first_id + i;
                Self::new(
                    id,
                    &format!("Placeholder Artist {id}"),
                    &format!("Placeholder Song {id}"),
                    newest_change - i64::from(i),
                )
            })
            .collect()
    }
}

struct Inner {
    fixtures: PathBuf,
    /// The song list `POST ?link=list` is rendered from, once set; until then
    /// `list.html` is served.
    songs: Mutex<Option<Vec<FakeSong>>>,
    /// Covers by USDB id (see [`FakeUsdb::set_cover`]).
    covers: Mutex<HashMap<u32, Vec<u8>>>,
    started: Instant,
    requests: Mutex<Vec<RecordedRequest>>,
    script: Mutex<VecDeque<ScriptEntry>>,
}

impl Inner {
    fn set_cover(&self, id: u32, bytes: Vec<u8>) {
        self.covers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, bytes);
    }

    fn set_songs(&self, songs: Vec<FakeSong>) {
        *self.songs.lock().unwrap_or_else(PoisonError::into_inner) = Some(songs);
    }

    /// The cover given for the cover path `path`, if any.
    fn cover(&self, path: &str) -> Option<Vec<u8>> {
        let id: u32 = path
            .strip_prefix("/data/cover/")?
            .strip_suffix(".jpg")?
            .parse()
            .ok()?;
        self.covers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned()
    }

    fn next_scripted(&self) -> Option<Scripted> {
        let mut script = self.script.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = script.front_mut()?;
        let response = entry.response.clone();
        entry.times -= 1;
        if entry.times == 0 {
            script.pop_front();
        }
        Some(response)
    }
}

/// A running fake USDB. It stops when dropped.
pub struct FakeUsdb {
    addr: SocketAddr,
    inner: Arc<Inner>,
    task: JoinHandle<()>,
}

impl FakeUsdb {
    /// The repo's saved pages, `fixtures/usdb/`.
    pub fn default_fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/usdb")
    }

    /// Serves the repo's saved pages on a free local port.
    pub async fn start() -> Self {
        Self::serve(
            Self::default_fixtures(),
            "127.0.0.1:0".parse().expect("an address"),
        )
        .await
        .expect("starting the fake USDB")
    }

    /// Serves the pages in `fixtures` on `addr` (port 0 picks a free one).
    pub async fn serve(fixtures: PathBuf, addr: SocketAddr) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        let inner = Arc::new(Inner {
            fixtures,
            songs: Mutex::new(None),
            covers: Mutex::new(HashMap::new()),
            started: Instant::now(),
            requests: Mutex::new(Vec::new()),
            script: Mutex::new(VecDeque::new()),
        });
        let app = Router::new().fallback(handle).with_state(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { addr, inner, task })
    }

    /// `http://127.0.0.1:<port>`, without a trailing slash: the USDB base URL
    /// the app under test is given.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The address it listens on.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Every request received so far, in arrival order.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.inner
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Answers the next `times` requests with `response` instead of the saved
    /// page. Scripts queue: a second call applies after the first runs out.
    pub fn script(&self, response: Scripted, times: usize) {
        if times == 0 {
            return;
        }
        self.inner
            .script
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(ScriptEntry { times, response });
    }

    /// From now on, `POST ?link=list` answers pages of this song list, in
    /// USDB's row shape: the form's `limit` rows from `start`, sorted by
    /// `order` (`lastchange`, else the id) and `ud` (`asc`/`desc`), with
    /// USDB's "There are N results" line. Replaces any list set before.
    pub fn set_songs(&self, songs: Vec<FakeSong>) {
        self.inner.set_songs(songs);
    }

    /// From now on, `GET /data/cover/<id>.jpg` answers `bytes` as a JPEG
    /// (an empty `bytes` answers an empty body, as a broken USDB might).
    pub fn set_cover(&self, id: u32, bytes: Vec<u8>) {
        self.inner.set_cover(id, bytes);
    }

    /// Waits until the server stops (it never does on its own): for the
    /// standalone process.
    pub async fn wait(self) {
        let _ = (&mut { self }.task).await;
    }
}

impl Drop for FakeUsdb {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Upper bound on a recorded request body.
const BODY_LIMIT: usize = 1 << 20;

async fn handle(State(inner): State<Arc<Inner>>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or_default().to_owned();
    let user_agent = header_text(request.headers(), header::USER_AGENT);
    let cookie = header_text(request.headers(), header::COOKIE);
    let body = match to_bytes(request.into_body(), BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };

    if let Some(control) = path.strip_prefix("/__fake/") {
        return control_endpoint(&inner, &method, control, &body);
    }

    inner
        .requests
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(RecordedRequest {
            method: method.to_string(),
            path: path.clone(),
            query: query.clone(),
            body: String::from_utf8_lossy(&body).into_owned(),
            user_agent,
            cookie: cookie.clone(),
            arrived: inner.started.elapsed(),
        });

    match inner.next_scripted() {
        Some(Scripted::Error {
            status,
            retry_after,
        }) => {
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let mut response = status.into_response();
            if let Some(seconds) = retry_after {
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
            }
            response
        }
        Some(Scripted::NotLoggedIn) => {
            serve_first(&inner.fixtures, &[NOT_LOGGED_IN_PAGE.into()]).await
        }
        Some(Scripted::Page) | None => {
            let is_index = path == "/" || path == "/index.php";
            let link = query_param(&query, "link").filter(|_| is_index);
            if link == Some("login") && method == Method::POST {
                return log_in(&inner.fixtures, &body).await;
            }
            let has_session = cookie
                .as_deref()
                .is_some_and(|cookie| cookie.split(';').any(|c| c.trim() == SESSION_COOKIE));
            if link == Some("list") && method == Method::POST {
                let songs = inner
                    .songs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();
                if let Some(songs) = songs {
                    let form = String::from_utf8_lossy(&body).into_owned();
                    return list_page(songs, &form);
                }
            }
            if let Some(cover) = inner.cover(&path) {
                return ([(header::CONTENT_TYPE, "image/jpeg")], cover).into_response();
            }
            if link == Some("profil") && !has_session {
                return serve_first(&inner.fixtures, &[LOGGED_OUT_PROFILE_PAGE.into()]).await;
            }
            serve_first(&inner.fixtures, &pages_for(&path, &query)).await
        }
    }
}

/// A song list page rendered from the fake's list, for the form `form`.
fn list_page(mut songs: Vec<FakeSong>, form: &str) -> Response {
    let number = |name: &str, default: usize| {
        query_param(form, name)
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let limit = number("limit", 20);
    let start = number("start", 0);
    match query_param(form, "order") {
        Some("lastchange") => songs.sort_by_key(|song| (song.last_change, song.id)),
        _ => songs.sort_by_key(|song| song.id),
    }
    if query_param(form, "ud") == Some("desc") {
        songs.reverse();
    }
    let total = songs.len();
    let rows: String = songs
        .iter()
        .skip(start)
        .take(limit)
        .enumerate()
        .map(|(i, song)| list_row(song, i % 2 + 1))
        .collect();
    let pages = total.div_ceil(limit.max(1));
    let html = format!(
        "<html><head><meta charset=\"UTF-8\"><title>USDB</title></head><body>\n\
         <table class='tablebg'><tr><td class='row1'>\n\
         There are  {total}  results on  {pages} page(s)<br><br>\n\
         <table border=\"0\" width=\"100%\">\n\
         <tr class=\"list_head\"><td>&nbsp;</td></tr>{rows}\n\
         </table>\n</td></tr></table>\n</body></html>\n"
    );
    ([(header::CONTENT_TYPE, "text/html")], html).into_response()
}

/// One row in the shape of `fixtures/usdb/list.html`.
fn list_row(song: &FakeSong, class: usize) -> String {
    let id = song.id;
    let cell = |text: &str| format!("<td onclick=\"show_detail({id})\">{}</td>\n", escape(text));
    let full = usize::from(song.half_stars / 2);
    let half = usize::from(song.half_stars % 2);
    let stars = "<img src=\"images/star.png\"> ".repeat(full)
        + &"<img src=\"images/half_star.png\"> ".repeat(half)
        + &"<img src=\"images/star2.png\"> ".repeat(5usize.saturating_sub(full + half));
    format!(
        "<tr class=\"list_tr{class}\" data-songid=\"{id}\" data-lastchange=\"{}\" \
         onmouseover=\"this.className='list_hover'\"><td style=\"text-align: center\"></td>\
         <td onclick=\"show_detail({id})\" style=\"text-align: center\">\
         <img src=\"data/cover/{id}.jpg\" height=\"40px\" width=\"40px\"></td>{}{}{}{}{}{}{}{}\
         <td onclick=\"show_detail({id})\">{stars}</td>\n{}\
         <td><a href=\"#\" onClick=\"addToList({id}, 1)\"></a></td>\n</tr>",
        song.last_change,
        cell(&song.artist),
        cell(&song.title),
        cell(&song.genre),
        cell(&song.year.map(|year| year.to_string()).unwrap_or_default()),
        cell(&song.edition),
        cell(if song.golden { "Yes" } else { "No" }),
        cell(&song.language),
        cell(&song.creator),
        cell(&song.views.to_string()),
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn header_text(headers: &axum::http::HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Answers a login form post: the start page, with the session cookie when
/// the form carries the fake credentials.
async fn log_in(fixtures: &Path, body: &[u8]) -> Response {
    let form = String::from_utf8_lossy(body).into_owned();
    let accepted = query_param(&form, "user") == Some(crate::FAKE_USDB_USERNAME)
        && query_param(&form, "pass") == Some(crate::FAKE_USDB_PASSWORD)
        && query_param(&form, "login") == Some("Login");
    let mut response = serve_first(fixtures, &["home.html".into()]).await;
    if accepted {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE}; path=/"))
                .expect("a valid header value"),
        );
    }
    response
}

fn control_endpoint(inner: &Inner, method: &Method, control: &str, body: &[u8]) -> Response {
    match (method.as_str(), control) {
        ("GET", "requests") => {
            let requests = inner
                .requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            axum::Json(requests).into_response()
        }
        ("POST", "script") => match serde_json::from_slice::<ScriptEntry>(body) {
            Ok(entry) if entry.times > 0 => {
                inner
                    .script
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push_back(entry);
                StatusCode::NO_CONTENT.into_response()
            }
            Ok(_) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
        },
        ("POST", "songs") => match serde_json::from_slice::<Vec<FakeSong>>(body) {
            Ok(songs) => {
                inner.set_songs(songs);
                StatusCode::NO_CONTENT.into_response()
            }
            Err(error) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
        },
        ("PUT", control) => match control
            .strip_prefix("covers/")
            .and_then(|id| id.parse::<u32>().ok())
        {
            Some(id) => {
                inner.set_cover(id, body.to_vec());
                StatusCode::NO_CONTENT.into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The fixture files (relative to the fixtures folder) that may answer a
/// request, most specific first. Empty when the request names no page.
fn pages_for(path: &str, query: &str) -> Vec<PathBuf> {
    if path == "/" || path == "/index.php" {
        return match query_param(query, "link") {
            None => vec!["home.html".into()],
            Some(link) if is_safe_name(link) => {
                let mut pages = Vec::new();
                if let Some(id) = query_param(query, "id").filter(|id| is_safe_name(id)) {
                    pages.push(format!("{link}-{id}.html").into());
                }
                pages.push(format!("{link}.html").into());
                pages
            }
            Some(_) => Vec::new(),
        };
    }
    let relative = Path::new(path.trim_start_matches('/'));
    let safe = relative.components().count() > 0
        && relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if safe {
        vec![Path::new("static").join(relative)]
    } else {
        Vec::new()
    }
}

/// Answers with the first of `candidates` that exists, or 404.
async fn serve_first(fixtures: &Path, candidates: &[PathBuf]) -> Response {
    for candidate in candidates {
        let path = fixtures.join(candidate);
        if let Ok(bytes) = tokio::fs::read(&path).await {
            let content_type = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html",
                Some("txt") => "text/plain",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("png") => "image/png",
                Some("json") => "application/json",
                _ => "application/octet-stream",
            };
            return ([(header::CONTENT_TYPE, content_type)], Body::from(bytes)).into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

fn is_safe_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('=').or(Some((pair, ""))))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

mod millis {
    use std::time::Duration;

    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Duration, D::Error> {
        u64::deserialize(deserializer).map(Duration::from_millis)
    }
}
