//! Every HTTP endpoint the server mounts, each classified by the guard rule.
//!
//! **The rule:** the Admin PIN guards whatever changes the Library's files,
//! deletes kept data, or takes the Stage. Everything else is not guarded.
//! The full v1 list is in `docs/agents/guard-rule.md`.
//!
//! This file is the only place that builds a router: [`router`] mounts each
//! endpoint with its [`Access`], and the guard comes from that classification,
//! never from the handler. A guarded endpoint is refused without a live Unlock
//! (`401 unlockRequired`); one that writes the Library is also refused while
//! the Library is read-only (`409 libraryReadOnly`), whatever the Unlock. The
//! tests in `crates/server/tests/guard.rs` walk [`Server::endpoints`] and a
//! test below fails if a router is built anywhere else.
//!
//! The WebSocket carries no guarded action: [`ws_access`] classifies every
//! client message, and every one is [`Access::NotGuarded`].
//!
//! [`Server::endpoints`]: crate::Server::endpoints

use axum::Router;
use axum::extract::{Request, State};
use axum::handler::Handler;
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{MethodFilter, on};
use openstar_protocol::ClientMessage;
use openstar_protocol::admin::ApiErrorCode;
use tower_http::trace::TraceLayer;

use crate::{
    AppState, bridge, frontend, jobs, library, local_mics, mic_bridges, mic_settings, profiles,
    scores, unlock, usdb,
};

/// Whether an endpoint needs an Unlock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Anyone may call it, whatever the browser.
    NotGuarded,
    /// It changes the Library's files, deletes kept data, or takes the Stage:
    /// it needs a live Unlock, and the call resets the Unlock's idle time.
    Guarded(Library),
}

/// Whether a guarded endpoint writes the Library (the songs folder).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Library {
    /// It writes the Library, so a read-only Library refuses it.
    Writes,
    /// It leaves the Library's files alone.
    Untouched,
}

/// One mounted HTTP endpoint and its classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub method: Method,
    /// The axum path, with `{name}` for path parameters.
    pub path: &'static str,
    pub access: Access,
}

/// The guard of every WebSocket client message. The WebSocket carries no
/// guarded action, so every arm is [`Access::NotGuarded`]; a guarded action
/// is an HTTP endpoint instead.
pub fn ws_access(message: &ClientMessage) -> Access {
    match message {
        ClientMessage::Ping { .. }
        | ClientMessage::NewParty
        | ClientMessage::PitchReading { .. }
        | ClientMessage::ClockPing { .. }
        | ClientMessage::ClockPong { .. }
        // Calibrate mics and setting a Mic threshold need no Admin PIN.
        | ClientMessage::StoreCalibration { .. }
        | ClientMessage::SetMicThreshold { .. }
        // Switching a Local mic on or off deletes nothing.
        | ClientMessage::SetLocalMicSwitchedOn { .. }
        // Naming a Local mic and Find it delete nothing: Find it moves what
        // is kept against a Local mic to its new channel.
        | ClientMessage::SetLocalMicName { .. }
        | ClientMessage::RelinkLocalMic { .. }
        // The OpenStar volume is everyone's, from the Stage or any Remote.
        | ClientMessage::ReportStageOutput { .. }
        | ClientMessage::StepVolume { .. }
        | ClientMessage::Hello { .. }
        | ClientMessage::CheckJoinCode { .. }
        | ClientMessage::Join { .. }
        // Switching who a Phone is and editing a member's name, look or
        // colour are everyone's, like Profile edits; nothing is deleted.
        | ClientMessage::SwitchIdentity { .. }
        | ClientMessage::EditMember { .. }
        // The Queue is everyone's: removing a Request deletes no kept data.
        | ClientMessage::AddRequest { .. }
        | ClientMessage::MoveRequest { .. }
        | ClientMessage::SetRequestedPlayers { .. }
        | ClientMessage::RemoveRequest { .. }
        | ClientMessage::ReportMicBlocked { .. }
        // Leave party and removing a Party member are everyone's (the
        // not-guarded list in docs/agents/guard-rule.md): a Party
        // membership is not kept data, and a Profile is never deleted.
        | ClientMessage::LeaveParty
        | ClientMessage::RemoveMember { .. }
        // Editing the Line-up and a Player's own Difficulty are everyone's
        // (spec #48: the Admin PIN plays no part); a Profile created for a
        // seat follows the not-guarded Profile create.
        | ClientMessage::EditLineUp { .. }
        | ClientMessage::SetMyDifficulty { .. }
        // Start, pause, Restart, End and Skip are for everyone in the room;
        // results come from the Stage, and Next or Done from anyone.
        | ClientMessage::ControlSong { .. }
        | ClientMessage::ReachedResults { .. }
        | ClientMessage::CloseResults
        // A bridge asking to join changes nothing until the Stage approves
        // it; approving needs no Admin PIN (becoming the Stage needed it).
        | ClientMessage::BridgeHello { .. }
        | ClientMessage::ApproveBridge { .. }
        // The Mics screen opening only lets bridges meter more channels;
        // levels are a meter, from approved bridges only.
        | ClientMessage::SetMicsScreenOpen { .. }
        | ClientMessage::BridgeLevels { .. } => Access::NotGuarded,
    }
}

/// The app's router and the classification of everything it mounts.
pub(crate) fn router(state: &AppState) -> (Router, Vec<Endpoint>) {
    use Access::{Guarded, NotGuarded};
    use Library::{Untouched, Writes};

    let mut routes = Routes::new(state)
        .add(Method::GET, "/healthz", NotGuarded, crate::healthz)
        .add(
            Method::GET,
            "/api/server-info",
            NotGuarded,
            crate::server_info,
        )
        .add(
            Method::GET,
            "/api/unlock",
            NotGuarded,
            unlock::unlock_status,
        )
        .add(Method::POST, "/api/unlock", NotGuarded, unlock::attempt)
        .add(
            Method::POST,
            "/api/unlock/heartbeat",
            Guarded(Untouched),
            unlock::heartbeat,
        )
        .add(Method::POST, "/api/lock", NotGuarded, unlock::lock)
        // Profiles: anyone creates, lists and edits them. Deleting one deletes
        // kept data, so it is guarded and lives in the Admin area.
        .add(
            Method::GET,
            "/api/profiles",
            NotGuarded,
            profiles::list_profiles,
        )
        .add(
            Method::POST,
            "/api/profiles",
            NotGuarded,
            profiles::create_profile,
        )
        .add(
            Method::GET,
            "/api/profiles/{id}",
            NotGuarded,
            profiles::get_profile,
        )
        .add(
            Method::PATCH,
            "/api/profiles/{id}",
            NotGuarded,
            profiles::edit_profile,
        )
        // Storing a round adds kept data and deletes nothing.
        .add(Method::POST, "/api/rounds", NotGuarded, scores::store_round)
        .add(Method::GET, "/api/jobs", NotGuarded, jobs::http::list)
        .add(Method::GET, "/api/songs", NotGuarded, library::songs)
        .add(Method::GET, "/api/songs/{id}", NotGuarded, library::song)
        .add(
            Method::GET,
            "/api/songs/{id}/high-scores",
            NotGuarded,
            scores::song_high_scores,
        )
        .add(
            Method::GET,
            "/api/songs/{id}/media/{role}",
            NotGuarded,
            library::media,
        )
        .add(
            Method::GET,
            "/api/library/problems",
            NotGuarded,
            library::problems,
        )
        .add(
            Method::GET,
            "/api/library/scan",
            NotGuarded,
            library::scan_status,
        )
        // Rescan and the Library problems need no PIN (docs/agents/guard-rule.md).
        .add(
            Method::POST,
            "/api/library/rescan",
            NotGuarded,
            library::rescan,
        )
        // Anyone reads Mic settings; the Stage writes them over its WebSocket.
        .add(
            Method::GET,
            "/api/mic-settings",
            NotGuarded,
            mic_settings::read,
        )
        // Anyone reads the kept Local mics; the Stage switches them over its
        // WebSocket.
        .add(Method::GET, "/api/local-mics", NotGuarded, local_mics::read)
        // Anyone sees which Mic bridges are approved, open or waiting; only
        // the Stage approves one, over its WebSocket.
        .add(
            Method::GET,
            "/api/mic-bridges",
            NotGuarded,
            mic_bridges::read,
        )
        // The USDB login's status, for the Downloads section's notices.
        .add(
            Method::GET,
            "/api/usdb/status",
            NotGuarded,
            usdb::http::status,
        )
        .add(Method::GET, "/ws", NotGuarded, crate::websocket)
        // Takes the Stage, but needs Stage trust (#186), not an Unlock.
        .add(Method::GET, "/ws/stage", NotGuarded, crate::stage_websocket)
        // A Mic bridge's own WebSocket: it may only ask to join, and the
        // Stage's approval is the guard.
        .add(
            Method::GET,
            "/ws/bridge",
            NotGuarded,
            crate::bridge_websocket,
        )
        .add(Method::GET, "/bridge/{file}", NotGuarded, bridge::serve);
    if state.test_routes {
        routes = routes
            .add(
                Method::POST,
                "/api/test/guarded",
                Guarded(Untouched),
                test_done,
            )
            .add(
                Method::POST,
                "/api/test/library-write",
                Guarded(Writes),
                test_done,
            )
            // The Profile delete through the Party (#89), until #199 mounts
            // it at `DELETE /api/profiles/{id}`. Deletes kept data.
            .add(
                Method::DELETE,
                "/api/test/profiles/{id}",
                Guarded(Untouched),
                profiles::delete_profile,
            )
            // Test jobs run a harmless child process and touch nothing kept.
            .add(
                Method::POST,
                "/api/test/jobs",
                NotGuarded,
                jobs::http::enqueue_test,
            )
            .add(
                Method::POST,
                "/api/test/jobs/{id}/cancel",
                NotGuarded,
                jobs::http::cancel_test,
            );
    }
    routes.finish()
}

/// A test-only guarded endpoint that does nothing, mounted only by
/// `Server::with_test_routes`.
async fn test_done() -> StatusCode {
    StatusCode::NO_CONTENT
}

/// Builds the router so that no endpoint can be mounted without an [`Access`].
struct Routes {
    state: AppState,
    router: Router<AppState>,
    endpoints: Vec<Endpoint>,
}

impl Routes {
    fn new(state: &AppState) -> Self {
        Self {
            state: state.clone(),
            router: Router::new(),
            endpoints: Vec::new(),
        }
    }

    fn add<H, T>(mut self, method: Method, path: &'static str, access: Access, handler: H) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        let filter = MethodFilter::try_from(method.clone())
            .unwrap_or_else(|_| panic!("{method} is not a routable method"));
        let mut route = on(filter, handler);
        if let Access::Guarded(library) = access {
            route = route.route_layer(middleware::from_fn_with_state(
                (self.state.clone(), library),
                guard,
            ));
        }
        self.router = self.router.route(path, route);
        self.endpoints.push(Endpoint {
            method,
            path,
            access,
        });
        self
    }

    fn finish(self) -> (Router, Vec<Endpoint>) {
        // The fallback serves the frontend for every other path; it is not guarded.
        let router = self
            .router
            .fallback(frontend::serve)
            .layer(TraceLayer::new_for_http())
            .with_state(self.state);
        (router, self.endpoints)
    }
}

/// The guard of every guarded endpoint. A read-only Library is checked first:
/// no PIN can make a Library write succeed then, so the PIN pad is not asked for.
async fn guard(
    State((state, library)): State<(AppState, Library)>,
    request: Request,
    next: Next,
) -> Response {
    if library == Library::Writes && state.library_read_only.is_some() {
        return unlock::refusal(StatusCode::CONFLICT, ApiErrorCode::LibraryReadOnly);
    }
    if let Some(refused) = unlock::refusal_without_unlock(&state, request.headers()).await {
        return refused;
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// Code that mounts routes or builds a router; it belongs in this file only.
    const ROUTING: &[&str] = &[
        "Router::new(",
        ".route(",
        ".route_service(",
        ".nest(",
        ".nest_service(",
        ".fallback(",
        ".fallback_service(",
        ".merge(",
    ];

    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn no_endpoint_is_mounted_outside_the_classified_table() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        assert!(files.iter().any(|f| f.ends_with("lib.rs")));
        let mut offenders = Vec::new();
        for file in files {
            if file.ends_with("endpoints.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&file).unwrap();
            for (n, line) in text.lines().enumerate() {
                if ROUTING.iter().any(|pattern| line.contains(pattern)) {
                    offenders.push(format!("{}:{}: {}", file.display(), n + 1, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "mount endpoints only in endpoints.rs, each with its Access:\n{}",
            offenders.join("\n")
        );
    }
}
