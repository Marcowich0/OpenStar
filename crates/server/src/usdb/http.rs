//! `GET /api/usdb/status`: where the USDB login stands, as a code.

use axum::Json;
use axum::extract::State;
use openstar_protocol::usdb::UsdbStatus;

use crate::AppState;

pub(crate) async fn status(State(state): State<AppState>) -> Json<UsdbStatus> {
    Json(UsdbStatus {
        state: state.usdb.status(),
    })
}
