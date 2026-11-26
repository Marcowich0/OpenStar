//! The USDB endpoints: `GET /api/usdb/status` (where the USDB login stands,
//! as a code), the mirror's `GET /api/usdb/mirror`,
//! `POST /api/usdb/mirror/refresh` and `POST /api/usdb/mirror/refetch`, and
//! the search over the mirror, `GET /api/usdb/songs`. (Covers are in
//! `covers`.)

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::usdb::{UsdbSearchQuery, UsdbStatus};

use super::mirror::{Ask, Mirror};
use crate::AppState;

pub(crate) async fn status(State(state): State<AppState>) -> Json<UsdbStatus> {
    Json(UsdbStatus {
        state: state.usdb.status(),
    })
}

/// `GET /api/usdb/songs?<UsdbSearchQuery>`: on the mirror alone.
pub(crate) async fn search(
    State(state): State<AppState>,
    Query(query): Query<UsdbSearchQuery>,
) -> Response {
    match state
        .db
        .call(move |conn| Ok(super::search::search(conn, &query)?))
        .await
    {
        Ok(results) => Json(results).into_response(),
        Err(error) => {
            tracing::error!(?error, "searching the USDB mirror");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
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
