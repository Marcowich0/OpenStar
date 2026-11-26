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
    scores, stage_outputs, stage_trust, unlock, usdb,
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
        | ClientMessage::MicPage { .. }
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
        // Check A/V sync is harmless and reversible and touches no Library
        // file: anyone in the Party starts, steps and ends it.
        | ClientMessage::StartAvSync
        | ClientMessage::StepAvSync { .. }
        | ClientMessage::EndAvSync
        | ClientMessage::ReportAvSyncOffset { .. }
        // Calibrate mics needs no Admin PIN (v1 spec #52): it stores only
        // Mic settings, which a later run overwrites.
        | ClientMessage::OpenCalibration
        | ClientMessage::ChooseCalibrationMic { .. }
        | ClientMessage::StartCalibration
        | ClientMessage::CalibrationListening
        | ClientMessage::CalibrationGo
        | ClientMessage::FinishCalibration { .. }
        | ClientMessage::EndCalibration
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
        // Next or Done from anyone (results come from the Stage over
        // `POST /api/rounds`).
        | ClientMessage::ControlSong { .. }
        | ClientMessage::CloseResults
        // The Stage's position report only tells Remotes how far the Song
        // has got; it changes nothing kept.
        | ClientMessage::ReportSongPosition { .. }
        // The Stage's Line-end totals only tell a seat's Phone its Score;
        // the stored Score comes with the round.
        | ClientMessage::ReportLineScore { .. }
        // A bridge asking to join changes nothing until the Stage approves
        // it; approving needs no Admin PIN (becoming the Stage needed it).
        | ClientMessage::BridgeHello { .. }
        | ClientMessage::ApproveBridge { .. }
        // The Mics screen opening only lets bridges meter more channels;
        // levels are a meter, from approved bridges only.
        | ClientMessage::SetMicsScreenOpen { .. }
        // Which Local mics are plugged in only says what the Line-up may
        // offer; nothing is kept.
        | ClientMessage::ReportPresentLocalMics { .. }
        // Which Local mics send digital silence only adds a seat warning.
        | ClientMessage::ReportSilentLocalMics { .. }
        | ClientMessage::BridgeLevels { .. }
        // A bridge's reported input delays are only a default Mic delay,
        // kept while it is open.
        | ClientMessage::BridgeInputDelays { .. } => Access::NotGuarded,
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
        // Stage trust: it checks the Admin PIN itself (through the shared
        // wrong-guess wait), not an Unlock, so it is not guarded here
        // (docs/agents/guard-rule.md).
        .add(
            Method::POST,
            "/api/stage/trust",
            NotGuarded,
            stage_trust::trust,
        )
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
        .add(
            Method::DELETE,
            "/api/profiles/{id}",
            Guarded(Untouched),
            profiles::delete_profile,
        )
        // Storing a round adds kept data and deletes nothing.
        .add(Method::POST, "/api/rounds", NotGuarded, scores::store_round)
        .add(Method::GET, "/api/jobs", NotGuarded, jobs::http::list)
        .add(Method::GET, "/api/songs", NotGuarded, library::songs)
        .add(Method::GET, "/api/songs/{id}", NotGuarded, library::song)
        // Deleting a Song moves its folder out of the Library (to the trash).
        .add(
            Method::DELETE,
            "/api/songs/{id}",
            Guarded(Writes),
            library::trash::delete,
        )
        // Computing and downloading a Pitch track change no file and delete
        // no kept data: the Timing editor opens a Song without a PIN.
        .add(
            Method::POST,
            "/api/songs/{id}/pitch-track",
            NotGuarded,
            library::pitch_track::request,
        )
        .add(
            Method::GET,
            "/api/songs/{id}/pitch-track",
            NotGuarded,
            library::pitch_track::download,
        )
        // A Phone's Fit to the singing: running it is guarded, and refused
        // at once while the Library is read-only, since its Accept is a
        // Library write (docs/agents/guard-rule.md).
        .add(
            Method::POST,
            "/api/songs/{id}/auto-fit",
            Guarded(Writes),
            library::pitch_track::auto_fit,
        )
        // A Timing edit's preview writes nothing; saving it and Restore
        // Original change the Song's `.txt` (docs/agents/guard-rule.md).
        .add(
            Method::POST,
            "/api/songs/{id}/timing/preview",
            NotGuarded,
            library::timing::preview,
        )
        .add(
            Method::POST,
            "/api/songs/{id}/timing",
            Guarded(Writes),
            library::timing::save,
        )
        .add(
            Method::POST,
            "/api/songs/{id}/restore-original",
            Guarded(Writes),
            library::timing::restore_original,
        )
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
        // The trash: listing it changes nothing; a restore moves a folder
        // back into the Library (docs/agents/guard-rule.md).
        .add(
            Method::GET,
            "/api/library/trash",
            NotGuarded,
            library::trash::list,
        )
        .add(
            Method::POST,
            "/api/library/trash/{id}/restore",
            Guarded(Writes),
            library::trash::restore,
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
        // Which Songs have an Original, for Restore Original's button.
        .add(
            Method::GET,
            "/api/library/originals",
            NotGuarded,
            library::timing::originals,
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
        // Any browser reads and sets its own A/V offset at its output: Check
        // A/V sync is harmless and reversible (docs/agents/guard-rule.md).
        .add(
            Method::GET,
            "/api/av-offset",
            NotGuarded,
            stage_outputs::read_av_offset,
        )
        .add(
            Method::PUT,
            "/api/av-offset",
            NotGuarded,
            stage_outputs::write_av_offset,
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
        // Forget deletes a bridge's Local mics and their Mic settings.
        .add(
            Method::DELETE,
            "/api/mic-bridges/{id}",
            Guarded(Untouched),
            mic_bridges::forget_bridge,
        )
        // The USDB login's status, for the Downloads section's notices.
        .add(
            Method::GET,
            "/api/usdb/status",
            NotGuarded,
            usdb::http::status,
        )
        // The USDB mirror: its status, an update when the Downloads section
        // opens, and a full refetch by hand. The mirror is a copy of USDB,
        // not kept data, so dropping songs USDB no longer has is not guarded.
        .add(
            Method::GET,
            "/api/usdb/mirror",
            NotGuarded,
            usdb::http::mirror,
        )
        .add(
            Method::POST,
            "/api/usdb/mirror/refresh",
            NotGuarded,
            usdb::http::refresh_mirror,
        )
        .add(
            Method::POST,
            "/api/usdb/mirror/refetch",
            NotGuarded,
            usdb::http::refetch_mirror,
        )
        // Browsing USDB is free: the search reads the mirror, and a cover is
        // fetched once into the cache (not the Library, not kept data).
        .add(
            Method::GET,
            "/api/usdb/songs",
            NotGuarded,
            usdb::http::search,
        )
        .add(
            Method::GET,
            "/api/usdb/songs/{id}/cover",
            NotGuarded,
            usdb::covers::cover,
        )
        // The video picker is free to open and use: it reads USDB's text and
        // comments and runs yt-dlp lookups, but writes nothing. Only starting
        // the Download needs the Admin PIN.
        .add(
            Method::GET,
            "/api/usdb/songs/{id}/videos",
            NotGuarded,
            usdb::videos::candidates_for,
        )
        .add(
            Method::GET,
            "/api/usdb/video-details",
            NotGuarded,
            usdb::videos::details,
        )
        // Starting a Download writes a new Song into the Library: guarded,
        // and refused on a read-only Library.
        .add(
            Method::POST,
            "/api/downloads",
            Guarded(Writes),
            usdb::download::start,
        )
        // Anyone may stop a Download: it removes only the Download's own
        // temporary folder, never the Library's files or kept data.
        .add(
            Method::POST,
            "/api/downloads/{id}/cancel",
            NotGuarded,
            usdb::download::cancel,
        )
        // Which USDB version of a text the Library holds; reads only.
        .add(
            Method::GET,
            "/api/usdb/songs/{id}/version",
            NotGuarded,
            usdb::download::text_version,
        )
        .add(Method::GET, "/ws", NotGuarded, crate::websocket)
        // Takes the Stage: the handler refuses a browser without Stage trust
        // (`stage_trust`), which is not an Unlock.
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
            // A new Song folder (#77), until Downloads (#47) call it.
            .add(
                Method::POST,
                "/api/test/library/new-song",
                Guarded(Writes),
                library::new_song_test,
            )
            // Stores a round as it comes (no Party checks), for tests of
            // Score records and High scores; keeps data, deletes none.
            .add(
                Method::POST,
                "/api/test/rounds",
                NotGuarded,
                scores::store_round_test,
            )
            // Test jobs run a harmless child process and touch nothing kept.
            .add(
                Method::POST,
                "/api/test/jobs",
                NotGuarded,
                jobs::http::enqueue_test,
            )
            // A Pitch track request with a short timeout, for its timeout path.
            .add(
                Method::POST,
                "/api/test/songs/{id}/pitch-track",
                NotGuarded,
                library::pitch_track::request_test,
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
