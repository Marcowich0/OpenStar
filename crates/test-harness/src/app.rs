//! The real app in-process, on its own folders and port.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use openstar::clock::ManualClock;
use openstar::usdb::UsdbTimer;
use openstar::{Config, Server, StartOptions};
use openstar_protocol::jobs::JobKind;
use openstar_protocol::library::ScanStatus;
use openstar_protocol::{ClientMessage, ServerMessage};
use serde::de::DeserializeOwned;
use tempfile::TempDir;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::{
    FAKE_USDB_PASSWORD, FAKE_USDB_USERNAME, FakeUsdb, FakeYtDlpReleases, USDB_BASE_URL_VAR,
    YTDLP_RELEASES_URL_VAR, YtDlpStub,
};

/// The Admin PIN a [`TestApp`] gets unless the test chooses another.
pub const DEFAULT_ADMIN_PIN: &str = "1234";

/// Where USDB points when no [`FakeUsdb`] is attached: port 9 (discard) on the
/// loopback address, which nothing listens on, so any USDB call fails fast.
const NO_USDB: &str = "http://127.0.0.1:9";

/// Where yt-dlp releases are when no [`FakeYtDlpReleases`] is attached: a
/// closed local port, never GitHub.
const CLOSED_RELEASES_URL: &str = "http://127.0.0.1:9/releases";

/// How long a WebSocket receive or a graceful stop may take before the test
/// fails; generous, since other builds may load the machine, and a passing
/// test never waits it out.
const WAIT: Duration = Duration::from_secs(30);

/// How long the start-up Library scan may take; generous, since other builds
/// may load the machine.
const SCAN_WAIT: Duration = Duration::from_secs(30);

/// The temporary songs and appdata folders of a [`TestApp`]. They are removed
/// when this value is dropped.
pub struct AppFolders {
    songs: TempDir,
    appdata: TempDir,
}

impl AppFolders {
    /// Two new, empty temporary folders.
    pub fn new() -> Self {
        Self {
            songs: tempfile::Builder::new()
                .prefix("openstar-songs-")
                .tempdir()
                .expect("creating a temporary songs folder"),
            appdata: tempfile::Builder::new()
                .prefix("openstar-appdata-")
                .tempdir()
                .expect("creating a temporary appdata folder"),
        }
    }

    /// The songs folder (`OPENSTAR_SONGS_DIR`).
    pub fn songs_dir(&self) -> &Path {
        self.songs.path()
    }

    /// The appdata folder (`OPENSTAR_APPDATA_DIR`).
    pub fn appdata_dir(&self) -> &Path {
        self.appdata.path()
    }
}

impl Default for AppFolders {
    fn default() -> Self {
        Self::new()
    }
}

/// Chooses how a [`TestApp`] starts. Get one from [`TestApp::builder`].
pub struct TestAppBuilder {
    folders: Option<AppFolders>,
    admin_pin: String,
    usdb_base_url: String,
    usdb_credentials: bool,
    path_prefix: Option<PathBuf>,
    extra: BTreeMap<String, String>,
    test_routes: bool,
    bridge_dir: Option<PathBuf>,
    ytdlp_releases_url: Option<String>,
    times: Times,
}

/// The time sources a [`TestApp`] runs on, kept across restarts.
#[derive(Clone, Default)]
struct Times {
    clock: Option<ManualClock>,
    usdb_timer: Option<Arc<dyn UsdbTimer>>,
    ytdlp_update_every: Option<Duration>,
}

impl Times {
    fn options(&self) -> StartOptions {
        StartOptions {
            clock: self
                .clock
                .as_ref()
                .map(ManualClock::clock)
                .unwrap_or_default(),
            usdb_timer: self.usdb_timer.clone(),
            ytdlp_update_every: self.ytdlp_update_every,
        }
    }
}

impl TestAppBuilder {
    /// Runs every timed rule, the background jobs' included, on `clock`
    /// (also after a [`TestApp::restart`]), so a test moves time forward
    /// instead of waiting.
    pub fn clock(mut self, clock: &ManualClock) -> Self {
        self.times.clock = Some(clock.clone());
        self
    }

    /// Paces and backs off USDB requests by `timer` (for example an
    /// `openstar::usdb::VirtualTimer`, whose waits take no real time) instead
    /// of real time, also after a [`TestApp::restart`].
    pub fn usdb_timer(mut self, timer: Arc<dyn UsdbTimer>) -> Self {
        self.times.usdb_timer = Some(timer);
        self
    }

    /// Mounts the server's test-only routes (`Server::with_test_routes`),
    /// also after a [`TestApp::restart`].
    pub fn test_routes(mut self) -> Self {
        self.test_routes = true;
        self
    }

    /// Serves the Mic bridge files under `/bridge/` from `dir`
    /// (`Server::with_bridge_dir`), also after a [`TestApp::restart`].
    pub fn bridge_dir(mut self, dir: &Path) -> Self {
        self.bridge_dir = Some(dir.to_path_buf());
        self
    }

    /// Starts on these folders instead of new ones (for example the folders a
    /// stopped app handed back, to start it again).
    pub fn folders(mut self, folders: AppFolders) -> Self {
        self.folders = Some(folders);
        self
    }

    /// The Admin PIN (`OPENSTAR_ADMIN_PIN`). Default [`DEFAULT_ADMIN_PIN`].
    pub fn admin_pin(mut self, pin: impl Into<String>) -> Self {
        self.admin_pin = pin.into();
        self
    }

    /// Points the app's USDB client at `usdb` and gives it fake credentials.
    pub fn usdb(mut self, usdb: &FakeUsdb) -> Self {
        self.usdb_base_url = usdb.base_url();
        self.usdb_credentials = true;
        self
    }

    /// Points the yt-dlp self-update at `releases` instead of GitHub and
    /// turns it on (`OPENSTAR_YTDLP_AUTOUPDATE=true` unless set with
    /// [`Self::var`]). Without it the update is off.
    pub fn ytdlp_releases(mut self, releases: &FakeYtDlpReleases) -> Self {
        self.ytdlp_releases_url = Some(releases.releases_url());
        self
    }

    /// Checks for a yt-dlp update this often instead of daily, also after a
    /// [`TestApp::restart`].
    pub fn ytdlp_update_every(mut self, every: Duration) -> Self {
        self.times.ytdlp_update_every = Some(every);
        self
    }

    /// Puts the stub's folder first on the `PATH` the app runs tools with.
    pub fn ytdlp_stub(mut self, stub: &YtDlpStub) -> Self {
        self.path_prefix = Some(stub.dir().to_path_buf());
        self
    }

    /// Puts `dir` first on the `PATH` the app runs tools with, for stand-in
    /// tools (an `ffmpeg` that waits or fails). Replaces [`Self::ytdlp_stub`]'s folder.
    pub fn tools_first(mut self, dir: &Path) -> Self {
        self.path_prefix = Some(dir.to_path_buf());
        self
    }

    /// Sets another settings variable. Variables the harness owns (the
    /// folders, the port, USDB, the yt-dlp releases URL) cannot be
    /// overridden this way; `OPENSTAR_YTDLP_AUTOUPDATE` can.
    pub fn var(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra.insert(name.into(), value.into());
        self
    }

    /// Starts the app and waits until it accepts connections.
    pub async fn start(self) -> TestApp {
        let folders = self.folders.unwrap_or_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binding a free local port");
        let addr = listener.local_addr().expect("the bound address");

        let mut vars = self.extra;
        let mut set = |name: &str, value: String| {
            vars.insert(name.to_owned(), value);
        };
        set("OPENSTAR_PORT", addr.port().to_string());
        set(
            "OPENSTAR_SONGS_DIR",
            folders.songs_dir().to_string_lossy().into_owned(),
        );
        set(
            "OPENSTAR_APPDATA_DIR",
            folders.appdata_dir().to_string_lossy().into_owned(),
        );
        set("OPENSTAR_ADMIN_PIN", self.admin_pin);
        set(USDB_BASE_URL_VAR, self.usdb_base_url);
        // On with a fake release server attached, unless the test says otherwise.
        vars.entry("OPENSTAR_YTDLP_AUTOUPDATE".to_owned())
            .or_insert_with(|| self.ytdlp_releases_url.is_some().to_string());
        let mut set = |name: &str, value: String| {
            vars.insert(name.to_owned(), value);
        };
        set(
            YTDLP_RELEASES_URL_VAR,
            self.ytdlp_releases_url
                .unwrap_or_else(|| CLOSED_RELEASES_URL.to_owned()),
        );
        set("PATH", tool_path(self.path_prefix.as_deref()));
        vars.remove("OPENSTAR_USDB_USERNAME");
        vars.remove("OPENSTAR_USDB_PASSWORD");
        if self.usdb_credentials {
            vars.insert(
                "OPENSTAR_USDB_USERNAME".to_owned(),
                FAKE_USDB_USERNAME.to_owned(),
            );
            vars.insert(
                "OPENSTAR_USDB_PASSWORD".to_owned(),
                FAKE_USDB_PASSWORD.to_owned(),
            );
        }

        let serving = serve(
            &vars,
            self.test_routes,
            self.bridge_dir.as_deref(),
            &self.times,
            listener,
        )
        .await;
        TestApp {
            addr,
            test_routes: self.test_routes,
            bridge_dir: self.bridge_dir,
            times: self.times,
            folders: Some(folders),
            vars,
            migrations_applied: serving.migrations_applied,
            http: reqwest::Client::new(),
            shutdown: Some(serving.shutdown),
            task: Some(serving.task),
        }
    }
}

struct Serving {
    migrations_applied: usize,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}

/// Runs the startup steps with `vars` as the only settings, then serves on
/// `listener`, and returns once the start-up Library scan has ended, so its
/// `changed` notice never reaches a test's WebSocket unasked.
async fn serve(
    vars: &BTreeMap<String, String>,
    test_routes: bool,
    bridge_dir: Option<&Path>,
    times: &Times,
    listener: tokio::net::TcpListener,
) -> Serving {
    let addr = listener.local_addr().expect("the bound address");
    let config = Config::from_vars(|name| vars.get(name).cloned())
        .expect("the harness's settings are valid");
    let mut server = Server::start_with(&config, times.options())
        .await
        .expect("the app starts");
    if test_routes {
        server = server.with_test_routes();
    }
    if let Some(dir) = bridge_dir {
        server = server.with_bridge_dir(dir);
    }
    let migrations_applied = server.migrations_applied();
    let (shutdown, shutdown_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(server.serve_with_shutdown(listener, async move {
        let _ = shutdown_rx.await;
    }));
    wait_for_the_start_up_scan(addr).await;
    Serving {
        migrations_applied,
        shutdown,
        task,
    }
}

/// Binds the stopped app's address again. The server's side of a connection
/// the client has not closed yet (a pooled HTTP connection, a WebSocket the
/// test still holds) stays in FIN-WAIT-2 and blocks the bind until the client
/// closes it, so this retries for a while.
async fn bind_again(addr: SocketAddr) -> tokio::net::TcpListener {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => return listener,
            Err(e)
                if e.kind() == std::io::ErrorKind::AddrInUse
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => panic!(
                "binding {addr} again: {e} (drop the WsClients that are still open before restart)"
            ),
        }
    }
}

/// Polls `GET /api/library/scan` until no scan runs. The scan starts before
/// the first request is answered, so a first answer never predates it.
async fn wait_for_the_start_up_scan(addr: SocketAddr) {
    let url = format!("http://{addr}/api/library/scan");
    let http = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + SCAN_WAIT;
    loop {
        let status: ScanStatus = http
            .get(&url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .unwrap_or_else(|e| panic!("GET {url}: {e}"))
            .json()
            .await
            .unwrap_or_else(|e| panic!("GET {url}: decoding the body: {e}"));
        if !status.running {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the start-up Library scan did not end within {SCAN_WAIT:?}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// The process's `PATH` with `prefix` in front of it.
fn tool_path(prefix: Option<&Path>) -> String {
    let rest = std::env::var_os("PATH").unwrap_or_default();
    let mut parts: Vec<PathBuf> = prefix.map(Path::to_path_buf).into_iter().collect();
    parts.extend(std::env::split_paths(&rest));
    let joined: OsString = std::env::join_paths(parts).expect("PATH entries without ':'");
    joined.to_string_lossy().into_owned()
}

/// The real OpenStar app, running in this process on a free local port with
/// its own songs and appdata folders and its own database.
pub struct TestApp {
    addr: SocketAddr,
    folders: Option<AppFolders>,
    vars: BTreeMap<String, String>,
    test_routes: bool,
    bridge_dir: Option<PathBuf>,
    times: Times,
    migrations_applied: usize,
    http: reqwest::Client,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

impl TestApp {
    /// Starts the app on new temporary folders with the default Admin PIN.
    pub async fn start() -> Self {
        Self::builder().start().await
    }

    /// Chooses the Admin PIN, the folders, a fake USDB or the yt-dlp stub first.
    pub fn builder() -> TestAppBuilder {
        TestAppBuilder {
            folders: None,
            admin_pin: DEFAULT_ADMIN_PIN.to_owned(),
            usdb_base_url: NO_USDB.to_owned(),
            usdb_credentials: false,
            path_prefix: None,
            extra: BTreeMap::new(),
            test_routes: false,
            bridge_dir: None,
            ytdlp_releases_url: None,
            times: Times::default(),
        }
    }

    /// `http://127.0.0.1:<port>`, without a trailing slash.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The address the app listens on.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The base URL joined with `path` (which starts with `/`).
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url())
    }

    /// An HTTP client for this app.
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// GETs `path`, expects a 2xx answer and decodes its JSON body as `T`.
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> T {
        let response = self
            .http
            .get(self.url(path))
            .send()
            .await
            .unwrap_or_else(|e| panic!("GET {path}: {e}"));
        let status = response.status();
        assert!(status.is_success(), "GET {path} answered {status}");
        response
            .json()
            .await
            .unwrap_or_else(|e| panic!("GET {path}: decoding the body: {e}"))
    }

    /// Opens a WebSocket to `/ws`.
    pub async fn connect_ws(&self) -> WsClient {
        self.connect_ws_at("/ws").await
    }

    /// Opens the Stage's WebSocket (`/ws/stage`) as a new browser that gives
    /// the Admin PIN first ([`TestApp::trust_stage_browser`]): it becomes the
    /// active Stage, taking over from any earlier one. Each call is another
    /// browser; to reconnect the same one, keep the cookie and use
    /// [`TestApp::connect_stage_as`].
    pub async fn connect_stage(&self) -> WsClient {
        let cookie = self.trust_stage_browser().await;
        self.connect_stage_as(&cookie).await
    }

    /// Opens the Stage's WebSocket with `cookie`, the `Cookie` header of a
    /// remembered Stage browser.
    pub async fn connect_stage_as(&self, cookie: &str) -> WsClient {
        self.try_connect_ws_at("/ws/stage", Some(cookie))
            .await
            .unwrap_or_else(|refused| panic!("the Stage's WebSocket was refused: {refused:?}"))
    }

    /// Gives the app's Admin PIN at `POST /api/stage/trust`, as a new browser
    /// would on `/stage`, and returns the `Cookie` header value
    /// (`openstar_stage=<token>`) that makes the browser a Stage browser.
    /// A correct PIN resets the shared wrong-guess count.
    pub async fn trust_stage_browser(&self) -> String {
        let pin = self
            .var("OPENSTAR_ADMIN_PIN")
            .expect("the Admin PIN is set");
        let response = self
            .http
            .post(self.url("/api/stage/trust"))
            .json(&serde_json::json!({ "pin": pin }))
            .send()
            .await
            .unwrap_or_else(|e| panic!("POST /api/stage/trust: {e}"));
        let status = response.status();
        assert!(
            status.is_success(),
            "POST /api/stage/trust answered {status}"
        );
        response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find(|value| value.starts_with(STAGE_COOKIE_PREFIX))
            .and_then(|value| value.split(';').next())
            .expect("a correct PIN sets the Stage cookie")
            .to_owned()
    }

    /// Gives the app's Admin PIN at `POST /api/unlock`, as the Admin area
    /// would, and returns the `Cookie` header value of the new Unlock, to send
    /// with guarded calls. A correct PIN resets the shared wrong-guess count.
    pub async fn unlock(&self) -> String {
        let pin = self
            .var("OPENSTAR_ADMIN_PIN")
            .expect("the Admin PIN is set");
        let response = self
            .http
            .post(self.url("/api/unlock"))
            .json(&serde_json::json!({ "pin": pin }))
            .send()
            .await
            .unwrap_or_else(|e| panic!("POST /api/unlock: {e}"));
        let status = response.status();
        assert!(status.is_success(), "POST /api/unlock answered {status}");
        response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .expect("a correct PIN sets the Unlock cookie")
            .trim()
            .to_owned()
    }

    /// Opens a WebSocket at `path` (starting with `/`).
    pub async fn connect_ws_at(&self, path: &str) -> WsClient {
        self.try_connect_ws_at(path, None)
            .await
            .unwrap_or_else(|refused| panic!("connecting to {path}: {refused:?}"))
    }

    /// Opens a WebSocket at `path`, sending `cookie` as the `Cookie` header if
    /// given; a refused upgrade comes back as its status and body.
    pub async fn try_connect_ws_at(
        &self,
        path: &str,
        cookie: Option<&str>,
    ) -> Result<WsClient, WsRefusal> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::HeaderValue;

        let url = format!("ws://{}{path}", self.addr);
        let mut request = url.as_str().into_client_request().expect("a WebSocket URL");
        if let Some(cookie) = cookie {
            request.headers_mut().insert(
                "cookie",
                HeaderValue::from_str(cookie).expect("a Cookie header value"),
            );
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((socket, _)) => Ok(WsClient { socket }),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(WsRefusal {
                status: reqwest::StatusCode::from_u16(response.status().as_u16())
                    .expect("an HTTP status"),
                body: response
                    .body()
                    .as_deref()
                    .map(|body| String::from_utf8_lossy(body).into_owned())
                    .unwrap_or_default(),
            }),
            Err(e) => panic!("connecting to {url}: {e}"),
        }
    }

    /// The songs folder.
    pub fn songs_dir(&self) -> &Path {
        self.folders().songs_dir()
    }

    /// The appdata folder.
    pub fn appdata_dir(&self) -> &Path {
        self.folders().appdata_dir()
    }

    fn folders(&self) -> &AppFolders {
        self.folders.as_ref().expect("folders are kept until stop")
    }

    /// How many database migrations this start applied.
    pub fn migrations_applied(&self) -> usize {
        self.migrations_applied
    }

    /// The value of a settings variable as the app under test sees it. The app
    /// sees only these variables, never the process environment.
    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    /// Stops the app and hands back its folders, still on disk, so a test can
    /// start it again on them.
    pub async fn stop(mut self) -> AppFolders {
        self.shut_down().await;
        self.folders.take().expect("folders are kept until stop")
    }

    /// Stops the app as a shutdown signal would (every WebSocket is closed),
    /// then starts it again on the same folders, settings and address, as a
    /// container restart does. Open [`WsClient`]s see their socket close; a
    /// new connection is told the reloaded live state.
    pub async fn restart(&mut self) {
        self.shut_down().await;
        let listener = bind_again(self.addr).await;
        let serving = serve(
            &self.vars,
            self.test_routes,
            self.bridge_dir.as_deref(),
            &self.times,
            listener,
        )
        .await;
        // Connections kept alive to the stopped app are dead: start afresh.
        self.http = reqwest::Client::new();
        self.migrations_applied = serving.migrations_applied;
        self.shutdown = Some(serving.shutdown);
        self.task = Some(serving.task);
    }

    async fn shut_down(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(mut task) = self.task.take()
            && tokio::time::timeout(WAIT, &mut task).await.is_err()
        {
            // Serving did not end in time: fail rather than hang, but end it.
            task.abort();
            let _ = task.await;
            panic!("the app did not stop within {WAIT:?}");
        }
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// The name and `=` that start the Stage cookie (`openstar_stage`).
const STAGE_COOKIE_PREFIX: &str = "openstar_stage=";

/// A WebSocket upgrade the app refused.
#[derive(Debug)]
pub struct WsRefusal {
    pub status: reqwest::StatusCode,
    /// The answer's body, as text (a `UserMessage` as JSON, for example).
    pub body: String,
}

/// A WebSocket to a [`TestApp`], speaking the protocol crate's messages.
pub struct WsClient {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl std::fmt::Debug for WsClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsClient").finish_non_exhaustive()
    }
}

impl WsClient {
    /// Sends a [`ClientMessage`].
    pub async fn send(&mut self, message: &ClientMessage) {
        let text = serde_json::to_string(message).expect("encoding a ClientMessage");
        self.send_text(&text).await;
    }

    /// Sends raw text, for messages that are not a valid [`ClientMessage`].
    pub async fn send_text(&mut self, text: &str) {
        self.socket
            .send(Message::text(text))
            .await
            .expect("sending on the WebSocket");
    }

    /// Waits up to five seconds for the next [`ServerMessage`], past the
    /// [`ServerMessage::JobChanged`] of Song loudness measurements: every
    /// Library with audio queues them after a scan, at times no test
    /// controls. Tests of those jobs read `GET /api/jobs`.
    pub async fn recv(&mut self) -> ServerMessage {
        loop {
            let message = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("a WebSocket message within 5 s")
                .expect("the WebSocket is open")
                .expect("reading the WebSocket");
            match message {
                Message::Text(text) => {
                    let message: ServerMessage = serde_json::from_str(&text)
                        .unwrap_or_else(|e| panic!("not a ServerMessage: {text}: {e}"));
                    if let ServerMessage::JobChanged { job } = &message
                        && job.kind == JobKind::Loudness
                    {
                        continue;
                    }
                    return message;
                }
                Message::Close(frame) => panic!("the WebSocket closed: {frame:?}"),
                _ => continue,
            }
        }
    }

    /// [`Self::recv`], also skipping the Party changes that only list the
    /// switched-on Local mics again (`localMicsChanged`): for tests of
    /// what the Local mics keep rather than of the Line-up.
    pub async fn recv_past_local_mics(&mut self) -> ServerMessage {
        loop {
            match self.recv().await {
                ServerMessage::PartyChanged { change, .. }
                    if change.event == openstar_protocol::PartyEvent::LocalMicsChanged => {}
                message => return message,
            }
        }
    }

    /// Waits up to five seconds for the server to close the WebSocket,
    /// skipping messages still in flight.
    pub async fn closed(&mut self) {
        tokio::time::timeout(WAIT, async {
            loop {
                match self.socket.next().await {
                    None | Some(Err(_) | Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .expect("the server closes the WebSocket within 5 s");
    }

    /// The underlying socket, for tests that read and write it separately.
    pub fn into_socket(self) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
        self.socket
    }
}
