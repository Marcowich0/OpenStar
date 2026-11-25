//! The real app in-process, on its own folders and port.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use openstar::{Config, Server};
use openstar_protocol::library::ScanStatus;
use openstar_protocol::{ClientMessage, ServerMessage};
use serde::de::DeserializeOwned;
use tempfile::TempDir;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::{FAKE_USDB_PASSWORD, FAKE_USDB_USERNAME, FakeUsdb, USDB_BASE_URL_VAR, YtDlpStub};

/// The Admin PIN a [`TestApp`] gets unless the test chooses another.
pub const DEFAULT_ADMIN_PIN: &str = "1234";

/// Where USDB points when no [`FakeUsdb`] is attached: port 9 (discard) on the
/// loopback address, which nothing listens on, so any USDB call fails fast.
const NO_USDB: &str = "http://127.0.0.1:9";

/// How long a WebSocket receive or a graceful stop may take before the test fails.
const WAIT: Duration = Duration::from_secs(5);

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
}

impl TestAppBuilder {
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

    /// Puts the stub's folder first on the `PATH` the app runs tools with.
    pub fn ytdlp_stub(mut self, stub: &YtDlpStub) -> Self {
        self.path_prefix = Some(stub.dir().to_path_buf());
        self
    }

    /// Sets another settings variable. Variables the harness owns (the
    /// folders, the port, USDB) cannot be overridden this way.
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
        set("OPENSTAR_YTDLP_AUTOUPDATE", "false".to_owned());
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

        let serving = serve(&vars, listener).await;
        TestApp {
            addr,
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
async fn serve(vars: &BTreeMap<String, String>, listener: tokio::net::TcpListener) -> Serving {
    let addr = listener.local_addr().expect("the bound address");
    let config = Config::from_vars(|name| vars.get(name).cloned())
        .expect("the harness's settings are valid");
    let server = Server::start(&config).await.expect("the app starts");
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
        let url = format!("ws://{}/ws", self.addr);
        let (socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .unwrap_or_else(|e| panic!("connecting to {url}: {e}"));
        WsClient { socket }
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
        let listener = tokio::net::TcpListener::bind(self.addr)
            .await
            .unwrap_or_else(|e| panic!("binding {} again: {e}", self.addr));
        let serving = serve(&self.vars, listener).await;
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

/// A WebSocket to a [`TestApp`], speaking the protocol crate's messages.
pub struct WsClient {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
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

    /// Waits up to five seconds for the next [`ServerMessage`].
    pub async fn recv(&mut self) -> ServerMessage {
        loop {
            let message = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("a WebSocket message within 5 s")
                .expect("the WebSocket is open")
                .expect("reading the WebSocket");
            match message {
                Message::Text(text) => {
                    return serde_json::from_str(&text)
                        .unwrap_or_else(|e| panic!("not a ServerMessage: {text}: {e}"));
                }
                Message::Close(frame) => panic!("the WebSocket closed: {frame:?}"),
                _ => continue,
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
