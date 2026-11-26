//! The USDB endpoints: `GET /api/usdb/status` (where the USDB login stands,
//! as a code) and the mirror's `GET /api/usdb/mirror`,
//! `POST /api/usdb/mirror/refresh` and `POST /api/usdb/mirror/refetch`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::usdb::UsdbStatus;

use super::mirror::{Ask, Mirror};
use crate::AppState;

pub(crate) async fn status(State(state): State<AppState>) -> Json<UsdbStatus> {
    Json(UsdbStatus {
        state: state.usdb.status(),
    })
}

/// `GET /api/usdb/mirror`.
pub(crate) async fn mirror(State(state): State<AppState>) -> Response {
    mirror_status(&state.mirror()).await
}

/// `POST /api/usdb/mirror/refresh`: the Downloads section opened.
pub(crate) async fn refresh_mirror(State(state): State<AppState>) -> Response {
    ask(&state.mirror(), Ask::Request).await
}

/// `POST /api/usdb/mirror/refetch`: a full refetch by hand.
pub(crate) async fn refetch_mirror(State(state): State<AppState>) -> Response {
    ask(&state.mirror(), Ask::Refetch).await
}

async fn ask(mirror: &Mirror, ask: Ask) -> Response {
    if let Err(error) = mirror.ask(ask).await {
        tracing::error!(?error, ?ask, "starting a USDB mirror run");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    mirror_status(mirror).await
}

async fn mirror_status(mirror: &Mirror) -> Response {
    match mirror.status().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => {
            tracing::error!(?error, "reading the USDB mirror's status");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
