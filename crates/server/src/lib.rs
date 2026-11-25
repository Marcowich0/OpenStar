//! The OpenStar server: the built frontend, the HTTP+JSON API and the
//! WebSocket, all on one origin over plain HTTP.

pub mod build_id;
mod config;
pub mod db;
mod frontend;
pub mod healthcheck;
mod startup;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use std::sync::Arc;

use openstar_protocol::{ClientMessage, LibraryReadOnly, RejectCode, ServerInfo, ServerMessage};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;

pub use config::{Config, Secret, UsdbCredentials};
use db::Database;

/// The build identifier, worked out by `build.rs` (see [`build_id`]).
pub const BUILD_ID: &str = env!("OPENSTAR_BUILD_ID");

#[derive(Clone)]
struct AppState {
    db: Database,
    config: Arc<Config>,
    /// Why the Library is read-only, if it is; fixed at startup.
    library_read_only: Option<LibraryReadOnly>,
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
        // #62 reloads the Party, Line-up and Queue here.
        tracing::info!("live state reloaded");
        Ok(Self {
            state: AppState {
                db: opened.database,
                config: Arc::new(config.clone()),
                library_read_only,
            },
            migrations_applied: opened.migrations_applied,
        })
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
        Router::new()
            .route("/healthz", get(healthz))
            .route("/api/server-info", get(server_info))
            .route("/ws", get(websocket))
            .fallback(frontend::serve)
            .layer(TraceLayer::new_for_http())
            .with_state(self.state.clone())
    }

    /// Serves on `listener` until the future is dropped or the shutdown signal arrives.
    pub async fn serve(self, listener: TcpListener) -> std::io::Result<()> {
        self.serve_with_shutdown(listener, std::future::pending())
            .await
    }

    /// Serves on `listener` until `shutdown` completes.
    pub async fn serve_with_shutdown(
        self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        axum::serve(listener, self.router())
            .with_graceful_shutdown(shutdown)
            .await
    }
}

/// Answers once the server is serving, for `openstar healthcheck`.
async fn healthz() -> &'static str {
    "ok"
}

async fn server_info(State(state): State<AppState>) -> Response {
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

async fn websocket(upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(connection)
}

async fn connection(mut socket: WebSocket) {
    while let Some(Ok(message)) = socket.recv().await {
        let Message::Text(text) = message else {
            continue;
        };
        let reply = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::Ping { nonce }) => ServerMessage::Pong { nonce },
            Err(error) => {
                tracing::debug!(%error, "rejecting a WebSocket message that is not a ClientMessage");
                ServerMessage::Rejected {
                    code: RejectCode::InvalidMessage,
                }
            }
        };
        let Ok(reply) = serde_json::to_string(&reply) else {
            continue;
        };
        if socket.send(Message::text(reply)).await.is_err() {
            break;
        }
    }
}
