//! The job runner's HTTP endpoints (mounted in `endpoints.rs`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::jobs::{JobId, JobList};

use super::{JobParams, TestJob};
use crate::AppState;

/// `GET /api/jobs`: every kept job, oldest first.
pub(crate) async fn list(State(state): State<AppState>) -> Response {
    match state.jobs.list().await {
        Some(jobs) => Json(JobList { jobs }).into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// `POST /api/test/jobs` (test routes only): queues a test job, answers its id.
pub(crate) async fn enqueue_test(
    State(state): State<AppState>,
    Json(job): Json<TestJob>,
) -> Response {
    match state.jobs.enqueue(JobParams::Test(job)).await {
        Ok(id) => Json(id).into_response(),
        Err(error) => {
            tracing::error!(?error, "queueing a test job");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `POST /api/test/jobs/{id}/cancel` (test routes only).
pub(crate) async fn cancel_test(State(state): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    if state.jobs.cancel(JobId(id)).await {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}
