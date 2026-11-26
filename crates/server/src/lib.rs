//! The OpenStar server: the built frontend, the HTTP+JSON API and the
//! WebSocket, all on one origin over plain HTTP.

mod bridge;
pub mod build_id;
pub mod clock;
mod config;
pub mod db;
pub mod endpoints;
mod frontend;
pub mod healthcheck;
pub mod jobs;
mod library;
mod live;
mod local_mics;
mod mic_bridges;
pub mod mic_settings;
mod pin_wait;
mod profiles;
pub mod scores;
pub mod stage_outputs;
mod startup;
pub mod txt;
mod unlock;
pub mod usdb;

use std::path::PathBuf;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::serve::{ListenerExt, TapIo};
use std::sync::Arc;

use openstar_protocol::{LibraryReadOnly, ServerInfo};
use tokio::net::{TcpListener, TcpStream};

use clock::Clock;
pub use config::{Config, Secret, UsdbCredentials};
use db::Database;
use jobs::Jobs;
use library::Scanner;
use live::LiveHandle;

/// The build identifier, worked out by `build.rs` (see [`build_id`]).
pub const BUILD_ID: &str = env!("OPENSTAR_BUILD_ID");

#[derive(Clone)]
struct AppState {
    db: Database,
    /// The folder `/bridge/{file}` is served from.
    bridge_dir: PathBuf,
    config: Arc<Config>,
    /// Why the Library is read-only, if it is; fixed at startup.
    library_read_only: Option<LibraryReadOnly>,
    /// The live-state task, which owns everything live.
    live: LiveHandle,
    /// The background job runner.
    jobs: Jobs,
    /// The only way to USDB.
    usdb: usdb::UsdbClient,
    /// Scans the Library into the index, one scan at a time.
    scanner: Scanner,
    /// The time source for every timed rule (the Unlock's idle time).
    clock: Clock,
    /// The running Admin PIN (its fingerprint: Unlocks made with another PIN
    /// no longer count) and the shared wrong-guess wait every PIN check goes
    /// through.
    admin_pin: pin_wait::AdminPin,
    /// Whether the test-only routes are mounted.
    test_routes: bool,
}

/// A started server: the database is open and migrated, nothing is served yet.
pub struct Server {
    state: AppState,
    migrations_applied: usize,
}

impl Server {
    /// Runs the startup steps after the configuration has been read, in the
    /// spec's order: the appdata check, the database (opened and migrated),
    /// the songs check, then reloading live state. Requests are accepted only
    /// once this has returned.
    pub async fn start(config: &Config) -> anyhow::Result<Self> {
        startup::check_appdata(&config.appdata_dir)?;
        let opened = Database::open(&config.appdata_dir).await?;
        tracing::info!(
            migrations_applied = opened.migrations_applied,
            "the database is ready"
        );
        let library_read_only = startup::check_songs(&config.songs_dir);
        library::clear_staging(&config.appdata_dir);
        // Step 5: reload the live state (the Party) before anything is served.
        let live = LiveHandle::start(opened.database.clone()).await?;
        tracing::info!("live state reloaded");
        let env = jobs::JobEnv {
            db: opened.database.clone(),
            live: live.clone(),
            songs_dir: config.songs_dir.clone(),
            appdata_dir: config.appdata_dir.clone(),
        };
        let jobs = Jobs::start(env.clone(), config.tool_path.clone()).await?;
        tracing::info!("job runner started");
        let scanner = Scanner::new(env, jobs.clone(), config.tool_path.clone());
        Ok(Self {
            state: AppState {
                scanner,
                db: opened.database,
                bridge_dir: PathBuf::from(bridge::DEFAULT_BRIDGE_DIR),
                config: Arc::new(config.clone()),
                library_read_only,
                live,
                jobs,
                usdb: usdb::UsdbClient::with_system_timer(
                    config.usdb_base_url.clone(),
                    config.usdb.clone(),
                ),
                clock: Clock::system(),
                admin_pin: pin_wait::AdminPin::new(config.admin_pin.expose()),
                test_routes: false,
            },
            migrations_applied: opened.migrations_applied,
        })
    }

    /// Serves the Mic bridge files under `/bridge/` from `dir` instead of
    /// the image's `/usr/share/openstar/bridge`.
    #[must_use]
    pub fn with_bridge_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.state.bridge_dir = dir.into();
        self
    }

    /// Runs every timed rule on `clock` instead of the system clock, so
    /// integration tests can move time forward.
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.state.clock = clock;
        self
    }

    /// Mounts the routes that exist only for tests: `POST /api/test/guarded`
    /// and `POST /api/test/library-write`, guarded endpoints that do nothing
    /// (the second is classified as writing the Library), and
    /// `POST /api/test/jobs` and `POST /api/test/jobs/{id}/cancel`, which
    /// queue and cancel test jobs ([`jobs::TestJob`]), and
    /// `POST /api/test/library/new-song`, which publishes a new Song folder
    /// the way a Download does. Never called by `main`.
    #[doc(hidden)]
    #[must_use]
    pub fn with_test_routes(mut self) -> Self {
        self.state.test_routes = true;
        self
    }

    /// The settings this server started with, for the areas that use them
    /// (the Admin PIN, the USDB login, yt-dlp updates).
    pub fn config(&self) -> &Config {
        &self.state.config
    }

    /// Why the Library is read-only, or `None` when the songs folder can be
    /// written to.
    pub fn library_read_only(&self) -> Option<&LibraryReadOnly> {
        self.state.library_read_only.as_ref()
    }

    /// How many database migrations this start applied.
    pub fn migrations_applied(&self) -> usize {
        self.migrations_applied
    }

    /// The axum app.
    pub fn router(&self) -> Router {
        endpoints::router(&self.state).0
    }

    /// Every HTTP endpoint this server mounts, each classified guarded or not
    /// guarded (see [`endpoints`]).
    pub fn endpoints(&self) -> Vec<endpoints::Endpoint> {
        endpoints::router(&self.state).1
    }

    /// Serves on `listener` until the future is dropped or the shutdown signal arrives.
    pub async fn serve(self, listener: TcpListener) -> std::io::Result<()> {
        self.serve_with_shutdown(listener, std::future::pending())
            .await
    }

    /// Starts the Library scan, then serves on `listener` until `shutdown`
    /// completes; the stored index is served while the scan runs. Then the
    /// scan stops, the live-state task stops and every WebSocket is closed,
    /// so browsers notice and reconnect to the next start.
    pub async fn serve_with_shutdown(
        self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        let live = self.state.live.clone();
        let jobs = self.state.jobs.clone();
        let scanner = self.state.scanner.clone();
        scanner.request();
        // The login is checked at start (on the profile page); without
        // credentials USDB is never contacted.
        if self.state.config.usdb.is_some() {
            let usdb = self.state.usdb.clone();
            tokio::spawn(async move {
                let state = usdb.check_login().await;
                tracing::info!(?state, "USDB login checked");
            });
        }
        let shutdown = async move {
            shutdown.await;
            scanner.shutdown().await;
            jobs.shutdown().await;
            live.shutdown().await;
        };
        // The peer address reaches handlers as `ConnectInfo`, for the log
        // line of a wrong Admin PIN guess.
        axum::serve(
            with_nodelay(listener),
            self.router()
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown)
        .await
    }
}

/// Sets `TCP_NODELAY` on every accepted socket, so small WebSocket messages
/// (Pitch readings, events) leave at once.
fn with_nodelay(listener: TcpListener) -> TapIo<TcpListener, fn(&mut TcpStream)> {
    listener.tap_io(set_nodelay)
}

fn set_nodelay(tcp: &mut TcpStream) {
    if let Err(error) = tcp.set_nodelay(true) {
        tracing::warn!(%error, "setting TCP_NODELAY");
    }
}

/// Answers once the server is serving, for `openstar healthcheck`.
pub(crate) async fn healthz() -> &'static str {
    "ok"
}

pub(crate) async fn server_info(State(state): State<AppState>) -> Response {
    match state.db.schema_version().await {
        Ok(schema_version) => axum::Json(ServerInfo {
            version: BUILD_ID.to_owned(),
            schema_version,
            library_read_only: state.library_read_only.clone(),
            public_url: state.config.public_url.clone(),
        })
        .into_response(),
        Err(error) => {
            tracing::error!(?error, "reading the schema version");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The WebSocket of every browser that is not the Stage.
pub(crate) async fn websocket(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| {
        live::connection::run(socket, state.live, live::Role::Browser, state.clock)
    })
}

/// The Stage's WebSocket: the browser that opens it becomes the active Stage.
pub(crate) async fn stage_websocket(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| {
        live::connection::run(socket, state.live, live::Role::Stage, state.clock)
    })
}

/// A Mic bridge's WebSocket: it asks to join with
/// [`openstar_protocol::ClientMessage::BridgeHello`].
pub(crate) async fn bridge_websocket(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| {
        live::connection::run(socket, state.live, live::Role::Bridge, state.clock)
    })
}

#[cfg(test)]
mod tests {
    use axum::serve::Listener;

    #[tokio::test]
    async fn every_accepted_socket_has_tcp_nodelay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut listener = super::with_nodelay(listener);
        let _client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (accepted, _) = listener.accept().await;
        assert!(accepted.nodelay().unwrap());
    }
}
