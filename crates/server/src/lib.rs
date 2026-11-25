//! The OpenStar server: the built frontend, the HTTP+JSON API and the
//! WebSocket, all on one origin over plain HTTP.

mod config;
pub mod db;
mod frontend;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use openstar_protocol::{ClientMessage, RejectCode, ServerInfo, ServerMessage};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;

pub use config::Config;
use db::Database;

/// The build identifier. Set `OPENSTAR_BUILD_ID` at compile time; `dev` otherwise.
pub const BUILD_ID: &str = match option_env!("OPENSTAR_BUILD_ID") {
    Some(id) => id,
    None => "dev",
};

#[derive(Clone)]
struct AppState {
    db: Database,
}

/// A started server: the database is open and migrated, nothing is served yet.
pub struct Server {
    state: AppState,
    migrations_applied: usize,
}

impl Server {
    /// Opens the database in the appdata folder and applies pending
    /// migrations. Requests are accepted only once this has returned.
    pub async fn start(config: &Config) -> anyhow::Result<Self> {
        let opened = Database::open(&config.appdata_dir).await?;
        Ok(Self {
            state: AppState {
                db: opened.database,
            },
            migrations_applied: opened.migrations_applied,
        })
    }

    /// How many database migrations this start applied.
    pub fn migrations_applied(&self) -> usize {
        self.migrations_applied
    }

    /// The axum app.
    pub fn router(&self) -> Router {
        Router::new()
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

async fn server_info(State(state): State<AppState>) -> Response {
    match state.db.schema_version().await {
        Ok(schema_version) => axum::Json(ServerInfo {
            version: BUILD_ID.to_owned(),
            schema_version,
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
