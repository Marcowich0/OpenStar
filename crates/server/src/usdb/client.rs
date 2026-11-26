//! The one place in the server that talks to USDB.
//!
//! Every request (login, profile, list pages, texts, detail pages, covers)
//! goes through one queue: a fair async lock held for the whole request,
//! its pacing wait, its backoff and its re-login. So at most one request is
//! in flight, each starts at least [`PACING`] after the previous one
//! finished, and a backoff holds every other request back.
//!
//! - Login: `POST ?link=login` with `user`, `pass`, `login=Login`; the
//!   cookies it sets are kept in memory only.
//! - [`UsdbClient::check_login`] logs in and reads `?link=profil` (at start).
//! - A page that [`is_not_logged_in`] logs in again and the request is
//!   retried exactly once.
//! - HTTP 429 and 5xx back off: `Retry-After` (seconds) when given, else 5 s
//!   doubling up to 5 minutes; after [`MAX_TRIES`] tries the request fails
//!   with [`UserMessage::UsdbGaveUp`].
//!
//! Errors are [`UserMessage`] codes; details go only to the log, and the
//! credentials never do.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use openstar_protocol::UserMessage;
use openstar_protocol::usdb::UsdbState;
use reqwest::{Method, StatusCode, header};

use super::login::{Profile, is_not_logged_in, parse_profile};
use crate::UsdbCredentials;

/// The least time between the end of one USDB request and the start of the
/// next.
pub const PACING: Duration = Duration::from_secs(1);
/// How many times one request is tried while USDB answers 429 or 5xx.
pub const MAX_TRIES: u32 = 5;
/// The first backoff wait without `Retry-After`; each further one doubles.
pub const FIRST_BACKOFF: Duration = Duration::from_secs(5);
/// The longest backoff wait without `Retry-After`.
pub const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The wait before try `failed_tries + 1` when USDB sent no `Retry-After`.
pub fn backoff_wait(failed_tries: u32) -> Duration {
    let doublings = failed_tries.saturating_sub(1).min(16);
    (FIRST_BACKOFF * 2u32.pow(doublings)).min(MAX_BACKOFF)
}

/// The time the client paces and backs off by. Production uses
/// [`SystemTimer`]; tests use [`VirtualTimer`], whose waits take no real time.
pub trait UsdbTimer: Send + Sync + 'static {
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// Real time, through tokio.
pub struct SystemTimer;

impl UsdbTimer for SystemTimer {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// A clock that moves only when the client waits: each wait returns at once,
/// moves the time forward by its length and is recorded, so tests check
/// backoff without real waits. Real time spent in requests does not count.
pub struct VirtualTimer {
    start: Instant,
    state: Mutex<(Duration, Vec<Duration>)>,
}

impl VirtualTimer {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            state: Mutex::new((Duration::ZERO, Vec::new())),
        }
    }

    /// Every wait so far, in order.
    pub fn waits(&self) -> Vec<Duration> {
        self.lock().1.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (Duration, Vec<Duration>)> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for VirtualTimer {
    fn default() -> Self {
        Self::new()
    }
}

impl UsdbTimer for VirtualTimer {
    fn now(&self) -> Instant {
        self.start + self.lock().0
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let mut state = self.lock();
        state.0 += duration;
        state.1.push(duration);
        Box::pin(std::future::ready(()))
    }
}

/// The USDB client. Cheap to clone; clones share one queue and one login.
#[derive(Clone)]
pub struct UsdbClient {
    shared: Arc<Shared>,
}

struct Shared {
    base_url: String,
    credentials: Option<UsdbCredentials>,
    http: reqwest::Client,
    timer: Arc<dyn UsdbTimer>,
    status: Mutex<UsdbState>,
    /// The queue: held for the whole of each request.
    queue: tokio::sync::Mutex<Session>,
}

/// What the queue's holder may change.
#[derive(Default)]
struct Session {
    /// The cookies USDB set, by name. In memory only.
    cookies: BTreeMap<String, String>,
    logged_in: bool,
    /// When the last request finished.
    last_done: Option<Instant>,
}

/// One request to USDB.
struct Call {
    method: Method,
    /// The path below the base URL, with its query.
    path: String,
    form: Vec<(&'static str, String)>,
    needs_login: bool,
    /// A page (HTML) that may come back as the "not logged in" page.
    is_page: bool,
}

struct Answer {
    status: StatusCode,
    /// `Retry-After` in seconds, when sent. (Its HTTP-date form counts as
    /// absent.)
    retry_after: Option<Duration>,
    body: Vec<u8>,
}

impl Call {
    fn get(path: &str, needs_login: bool) -> Self {
        Self {
            method: Method::GET,
            path: path.to_owned(),
            form: Vec::new(),
            needs_login,
            is_page: true,
        }
    }

    fn post(path: String) -> Self {
        Self {
            method: Method::POST,
            path,
            form: Vec::new(),
            needs_login: true,
            is_page: true,
        }
    }
}

/// The status an error leaves the login in.
fn state_for(message: &UserMessage) -> UsdbState {
    lasting_state_for(message).unwrap_or(UsdbState::LoginFailed)
}

/// The status an error of a request changes the login to, if any.
fn lasting_state_for(message: &UserMessage) -> Option<UsdbState> {
    match message {
        UserMessage::UsdbUnreachable => Some(UsdbState::Unreachable),
        UserMessage::UsdbGaveUp { .. } => Some(UsdbState::GaveUp),
        UserMessage::UsdbNotLoggedIn | UserMessage::UsdbLoginFailed => Some(UsdbState::LoginFailed),
        UserMessage::UsdbCredentialsMissing => Some(UsdbState::CredentialsMissing),
        _ => None,
    }
}

impl UsdbClient {
    /// A client for USDB at `base_url` (no trailing slash). Without
    /// credentials it never sends a request.
    pub fn new(
        base_url: impl Into<String>,
        credentials: Option<UsdbCredentials>,
        timer: Arc<dyn UsdbTimer>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(format!("OpenStar/{}", crate::BUILD_ID))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("building the USDB HTTP client");
        let status = if credentials.is_some() {
            UsdbState::Checking
        } else {
            UsdbState::CredentialsMissing
        };
        Self {
            shared: Arc::new(Shared {
                base_url: base_url.into(),
                credentials,
                http,
                timer,
                status: Mutex::new(status),
                queue: tokio::sync::Mutex::new(Session::default()),
            }),
        }
    }

    /// A client on real time.
    pub fn with_system_timer(
        base_url: impl Into<String>,
        credentials: Option<UsdbCredentials>,
    ) -> Self {
        Self::new(base_url, credentials, Arc::new(SystemTimer))
    }

    /// Waits `duration` on the client's timer (virtual in tests), outside
    /// the queue: a Download's retry waits.
    pub(crate) async fn wait(&self, duration: Duration) {
        self.shared.timer.sleep(duration).await;
    }

    /// Where the login stands now.
    pub fn status(&self) -> UsdbState {
        *self
            .shared
            .status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn set_status(&self, state: UsdbState) {
        *self
            .shared
            .status
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = state;
    }

    /// Logs in and reads the profile page to see whether the login holds.
    /// Run at start. Answers the new status.
    pub async fn check_login(&self) -> UsdbState {
        if self.shared.credentials.is_none() {
            return UsdbState::CredentialsMissing;
        }
        let mut session = self.shared.queue.lock().await;
        let result = async {
            self.log_in(&mut session).await?;
            let profile = self
                .paced(&mut session, &Call::get("/index.php?link=profil", true))
                .await?;
            Ok::<_, UserMessage>(parse_profile(&String::from_utf8_lossy(&profile.body)))
        }
        .await;
        let state = match result {
            Ok(Profile::LoggedIn { .. }) => UsdbState::LoggedIn,
            Ok(Profile::LoggedOut) => {
                session.logged_in = false;
                tracing::warn!("USDB did not accept the login (the profile page shows none)");
                UsdbState::LoginFailed
            }
            Err(message) => state_for(&message),
        };
        self.set_status(state);
        state
    }

    /// One song list page (`POST ?link=list`): 100 rows from `start`, sorted
    /// by `order` (for example `lastchange`), `ud` `asc` or `desc`.
    pub async fn song_list_page(
        &self,
        start: u32,
        order: &str,
        ud: &str,
    ) -> Result<String, UserMessage> {
        let call = Call {
            form: vec![
                ("limit", "100".to_owned()),
                ("start", start.to_string()),
                ("order", order.to_owned()),
                ("ud", ud.to_owned()),
            ],
            ..Call::post("/index.php?link=list".to_owned())
        };
        self.page(call).await
    }

    /// A song's text page (`POST ?link=gettxt&id=N` with `wd=1`).
    pub async fn song_text_page(&self, id: u32) -> Result<String, UserMessage> {
        let call = Call {
            form: vec![("wd", "1".to_owned())],
            ..Call::post(format!("/index.php?link=gettxt&id={id}"))
        };
        self.page(call).await
    }

    /// A song's detail page with its comments (`GET ?link=detail&id=N`); needs
    /// no login.
    pub async fn detail_page(&self, id: u32) -> Result<String, UserMessage> {
        self.page(Call::get(&format!("/index.php?link=detail&id={id}"), false))
            .await
    }

    /// A song's cover (`GET /data/cover/<id>.jpg`), or `None` when USDB has
    /// none (404). Needs no login.
    pub async fn cover(&self, id: u32) -> Result<Option<Vec<u8>>, UserMessage> {
        let call = Call {
            is_page: false,
            ..Call::get(&format!("/data/cover/{id}.jpg"), false)
        };
        match self.request(&call).await {
            Ok(answer) => Ok(Some(answer.body)),
            Err(UserMessage::UsdbUnexpectedStatus { status: 404 }) => Ok(None),
            Err(message) => Err(message),
        }
    }

    async fn page(&self, call: Call) -> Result<String, UserMessage> {
        let answer = self.request(&call).await?;
        Ok(String::from_utf8_lossy(&answer.body).into_owned())
    }

    /// Sends `call` through the queue, with its login and one re-login.
    async fn request(&self, call: &Call) -> Result<Answer, UserMessage> {
        if self.shared.credentials.is_none() {
            return Err(UserMessage::UsdbCredentialsMissing);
        }
        let mut session = self.shared.queue.lock().await;
        let result = self.request_in(&mut session, call).await;
        match &result {
            Ok(_) if call.needs_login => self.set_status(UsdbState::LoggedIn),
            Ok(_) => {}
            Err(message) => {
                if let Some(state) = lasting_state_for(message) {
                    self.set_status(state);
                }
            }
        }
        result
    }

    async fn request_in(&self, session: &mut Session, call: &Call) -> Result<Answer, UserMessage> {
        if call.needs_login && !session.logged_in {
            self.log_in(session).await?;
        }
        let answer = self.ok(self.paced(session, call).await?)?;
        if !self.is_not_logged_in(call, &answer) {
            return Ok(answer);
        }
        tracing::info!(path = %call.path, "USDB answered \"not logged in\": logging in again");
        session.logged_in = false;
        self.log_in(session).await?;
        let answer = self.ok(self.paced(session, call).await?)?;
        if self.is_not_logged_in(call, &answer) {
            session.logged_in = false;
            tracing::warn!(path = %call.path, "USDB still answered \"not logged in\" after logging in again");
            return Err(UserMessage::UsdbNotLoggedIn);
        }
        Ok(answer)
    }

    fn is_not_logged_in(&self, call: &Call, answer: &Answer) -> bool {
        call.is_page && is_not_logged_in(&String::from_utf8_lossy(&answer.body))
    }

    fn ok(&self, answer: Answer) -> Result<Answer, UserMessage> {
        if answer.status.is_success() {
            Ok(answer)
        } else {
            Err(UserMessage::UsdbUnexpectedStatus {
                status: answer.status.as_u16(),
            })
        }
    }

    /// Posts the login form. USDB answers a login with its start page
    /// whether or not it accepted it; [`Self::check_login`] tells which.
    async fn log_in(&self, session: &mut Session) -> Result<(), UserMessage> {
        let credentials = self
            .shared
            .credentials
            .as_ref()
            .ok_or(UserMessage::UsdbCredentialsMissing)?;
        let call = Call {
            form: vec![
                ("user", credentials.username.clone()),
                ("pass", credentials.password.expose().to_owned()),
                ("login", "Login".to_owned()),
            ],
            needs_login: false,
            ..Call::post("/index.php?link=login".to_owned())
        };
        self.ok(self.paced(session, &call).await?)?;
        session.logged_in = true;
        Ok(())
    }

    /// Sends `call` once its pacing allows, backing off on 429 and 5xx.
    async fn paced(&self, session: &mut Session, call: &Call) -> Result<Answer, UserMessage> {
        let timer = &self.shared.timer;
        let mut not_before = session.last_done.map(|done| done + PACING);
        let mut tries = 0;
        loop {
            if let Some(not_before) = not_before {
                let wait = not_before.saturating_duration_since(timer.now());
                if !wait.is_zero() {
                    timer.sleep(wait).await;
                }
            }
            tries += 1;
            let sent = self.send(session, call).await;
            let done = timer.now();
            session.last_done = Some(done);
            let answer = sent?;
            let status = answer.status;
            if !(status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) {
                return Ok(answer);
            }
            if tries >= MAX_TRIES {
                tracing::warn!(path = %call.path, %status, tries, "USDB: giving up after backing off");
                return Err(UserMessage::UsdbGaveUp {
                    status: status.as_u16(),
                });
            }
            let wait = answer.retry_after.unwrap_or_else(|| backoff_wait(tries));
            tracing::info!(path = %call.path, %status, ?wait, "USDB: backing off");
            not_before = Some((done + wait).max(done + PACING));
        }
    }

    async fn send(&self, session: &mut Session, call: &Call) -> Result<Answer, UserMessage> {
        let url = format!("{}{}", self.shared.base_url, call.path);
        let mut request = self.shared.http.request(call.method.clone(), &url);
        if !session.cookies.is_empty() {
            let cookie = session
                .cookies
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; ");
            request = request.header(header::COOKIE, cookie);
        }
        if call.method == Method::POST {
            request = request.form(&call.form);
        }
        let unreachable = |error: reqwest::Error| {
            // Never log the URL with a body: the login form holds the password.
            tracing::warn!(path = %call.path, error = %error.without_url(), "USDB could not be reached");
            UserMessage::UsdbUnreachable
        };
        let response = request.send().await.map_err(unreachable)?;
        for set_cookie in response.headers().get_all(header::SET_COOKIE) {
            if let Some((name, value)) = set_cookie
                .to_str()
                .ok()
                .and_then(|text| text.split(';').next())
                .and_then(|pair| pair.split_once('='))
            {
                session
                    .cookies
                    .insert(name.trim().to_owned(), value.trim().to_owned());
            }
        }
        let status = response.status();
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|text| text.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let body = response.bytes().await.map_err(unreachable)?.to_vec();
        Ok(Answer {
            status,
            retry_after,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_wait_doubles_from_5_s_and_stops_at_5_minutes() {
        let seconds: Vec<u64> = (1..=9).map(|n| backoff_wait(n).as_secs()).collect();
        assert_eq!(seconds, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
        assert_eq!(backoff_wait(u32::MAX), MAX_BACKOFF);
    }
}
