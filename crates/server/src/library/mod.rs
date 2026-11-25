//! The Library index: scanning `/songs` into SQLite at every start and on a
//! Rescan, and serving the playable Songs, a Song's detail and the Library
//! problems over HTTP, the Song list with its search and filters (see `openstar_protocol::library` for the endpoints).
//!
//! One scan runs at a time. A Rescan asked for while a scan runs starts no
//! second scan: it answers with the running scan's status. There is no
//! filesystem watcher. When a scan finishes, every browser is sent a
//! [`ChangeTopic::Library`] notice, after the Party was told which Songs
//! left the Library (were playable before the scan and are not after it),
//! so it drops their queued Requests.

mod artwork;
mod conversion;
mod identity;
mod index;
mod probe;
mod probing;
mod resolve;
mod scan;
mod search;

pub use conversion::Conversion;
pub(crate) use identity::key as identity_key;
pub(crate) use index::song as song_detail;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::ChangeTopic;
use openstar_protocol::library::{ScanStatus, SongId, SongQuery};
use tokio::sync::watch;
use tower_http::services::ServeFile;

use crate::AppState;
use crate::db::Database;
use crate::jobs::{JobEnv, Jobs, Slot};
use crate::live::LiveHandle;

/// Runs scans, one at a time. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Scanner {
    inner: Arc<Inner>,
}

struct Inner {
    db: Database,
    songs_dir: PathBuf,
    appdata_dir: PathBuf,
    live: LiveHandle,
    /// Runs the media conversions the scan starts.
    jobs: Jobs,
    parser_version: u32,
    status: watch::Sender<ScanStatus>,
    cancelled: Arc<AtomicBool>,
    /// Set with `cancelled`, so a running ffprobe is killed.
    cancel: watch::Sender<bool>,
    /// `PATH` for ffprobe, from the settings.
    tool_path: Option<String>,
}

impl Scanner {
    /// `tool_path` is the `PATH` ffprobe runs with (`None`: the process's own).
    pub(crate) fn new(env: JobEnv, jobs: Jobs, tool_path: Option<String>) -> Self {
        let JobEnv {
            db,
            live,
            songs_dir,
            appdata_dir,
        } = env;
        let (status, _) = watch::channel(ScanStatus {
            running: false,
            finished: 0,
            last: None,
        });
        Self {
            inner: Arc::new(Inner {
                db,
                songs_dir,
                appdata_dir,
                live,
                jobs,
                parser_version: crate::txt::PARSER_VERSION,
                status,
                cancelled: Arc::new(AtomicBool::new(false)),
                cancel: watch::channel(false).0,
                tool_path,
            }),
        }
    }

    pub(crate) fn status(&self) -> ScanStatus {
        *self.inner.status.borrow()
    }

    /// Starts a scan unless one is running (or the scanner has stopped), and
    /// returns the status after that.
    pub(crate) fn request(&self) -> ScanStatus {
        if self.inner.cancelled.load(Ordering::Relaxed) {
            return self.status();
        }
        let started = self.inner.status.send_if_modified(|status| {
            if status.running {
                false
            } else {
                status.running = true;
                true
            }
        });
        if started {
            tokio::spawn(Arc::clone(&self.inner).run());
        }
        self.status()
    }

    /// Stops a running scan between two batches and waits for it to end.
    /// No scan starts afterwards.
    pub(crate) async fn shutdown(&self) {
        self.inner.cancelled.store(true, Ordering::Relaxed);
        self.inner.cancel.send_replace(true);
        let mut status = self.inner.status.subscribe();
        let _ = status.wait_for(|s| !s.running).await;
    }
}

impl Inner {
    async fn run(self: Arc<Self>) {
        tracing::info!(songs_dir = %self.songs_dir.display(), "scanning the Library");
        let slot = Slot::outside_lanes(self.tool_path.clone(), self.cancel.subscribe());
        let before = match self.db.call(playable_titles).await {
            Ok(before) => before,
            Err(error) => {
                tracing::error!(?error, "reading the playable Songs before a scan");
                Vec::new()
            }
        };
        let outcome = scan::run(
            &self.db,
            &self.songs_dir,
            self.parser_version,
            &slot,
            &self.cancelled,
            &self.jobs,
            &self.appdata_dir,
        )
        .await;
        let report = match outcome {
            Ok(Some(report)) => {
                tracing::info!(
                    read = report.read,
                    unchanged = report.unchanged,
                    removed = report.removed,
                    probed = report.probed,
                    "the Library scan finished"
                );
                Some(report)
            }
            Ok(None) => {
                tracing::info!("the Library scan stopped");
                None
            }
            Err(error) => {
                tracing::error!(?error, "the Library scan failed");
                None
            }
        };
        self.status.send_modify(|status| {
            status.running = false;
            if let Some(report) = report {
                status.finished += 1;
                status.last = Some(report);
            }
        });
        if report.is_some() {
            match self.db.call(playable_titles).await {
                Ok(after) => {
                    let after: std::collections::HashSet<SongId> =
                        after.into_iter().map(|(id, _)| id).collect();
                    let left = before
                        .into_iter()
                        .filter(|(id, _)| !after.contains(id))
                        .collect();
                    self.live.songs_left(left).await;
                }
                Err(error) => tracing::error!(?error, "reading the playable Songs after a scan"),
            }
            self.live.changed(vec![ChangeTopic::Library]).await;
        }
    }
}

/// Every playable Song with its title: what the Party may have queued.
fn playable_titles(conn: &mut rusqlite::Connection) -> rusqlite::Result<Vec<(SongId, String)>> {
    let mut statement =
        conn.prepare("SELECT id, COALESCE(title, '') FROM library_files WHERE playable = 1")?;
    statement
        .query_map([], |row| Ok((SongId(row.get(0)?), row.get(1)?)))?
        .collect()
}

fn server_error(error: &anyhow::Error) -> Response {
    tracing::error!(?error, "reading the Library index");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// `GET /api/songs?<SongQuery>`: the listed Songs that match, and the values
/// each filter can take. A query value that does not parse is axum's `400`.
pub(crate) async fn songs(
    State(state): State<AppState>,
    Query(query): Query<SongQuery>,
) -> Response {
    let listed = state
        .db
        .call(|conn| {
            let mut listed = index::listed(conn)?;
            let mut tops = crate::scores::top_high_scores(conn)?;
            for song in &mut listed {
                song.summary.top_high_score = tops.remove(&identity_key(&song.summary.identity));
            }
            Ok(listed)
        })
        .await;
    match listed {
        Ok(listed) => axum::Json(search::apply(listed, &query)).into_response(),
        Err(error) => server_error(&error),
    }
}

/// `GET /api/songs/{id}`.
pub(crate) async fn song(State(state): State<AppState>, Path(id): Path<u32>) -> Response {
    match state
        .db
        .call(move |conn| index::song(conn, SongId(id)))
        .await
    {
        Ok(Some(song)) => axum::Json(song).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => server_error(&error),
    }
}

/// `GET /api/songs/{id}/media/{role}`: the Song's `audio`, `video`, `cover`
/// or `background` file (a media file's converted copy in `/appdata/cache`
/// once there is one, at the same URL), with `Range` requests, `ETag` and `Last-Modified`
/// (tower-http's `ServeFile`). `404` for an unknown role, an id that is not
/// a playable Song, or a role the Song has no file for.
pub(crate) async fn media(
    State(state): State<AppState>,
    Path((id, role)): Path<(u32, String)>,
    request: Request,
) -> Response {
    let Some(role) = index::MediaRole::from_name(&role) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = match state
        .db
        .call(move |conn| index::media_path(conn, SongId(id), role))
        .await
    {
        Ok(Some(path)) => path,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return server_error(&error),
    };
    let served = match conversion::served(
        &state.db,
        &state.config.songs_dir,
        &state.config.appdata_dir,
        &path,
    )
    .await
    {
        Ok(served) => served,
        Err(error) => return server_error(&error),
    };
    match ServeFile::new(served).try_call(request).await {
        Ok(response) => response.map(axum::body::Body::new),
        Err(error) => {
            tracing::error!(%error, path, "serving a Song's media");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /api/library/problems`.
pub(crate) async fn problems(State(state): State<AppState>) -> Response {
    match state.db.call(|conn| index::problems(conn)).await {
        Ok(problems) => axum::Json(problems).into_response(),
        Err(error) => server_error(&error),
    }
}

/// `GET /api/library/scan`.
pub(crate) async fn scan_status(State(state): State<AppState>) -> Response {
    axum::Json(state.scanner.status()).into_response()
}

/// `POST /api/library/rescan`: no PIN.
pub(crate) async fn rescan(State(state): State<AppState>) -> Response {
    (StatusCode::ACCEPTED, axum::Json(state.scanner.request())).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::library::SongIdentity;

    /// A scanner without ffprobe and ffmpeg (an empty `PATH`): these tests
    /// look at `.txt` files only, so their empty media is never probed.
    async fn scanner(songs: &std::path::Path, appdata: &std::path::Path) -> Scanner {
        let db = Database::open(appdata).await.unwrap().database;
        let live = LiveHandle::start(db.clone()).await.unwrap();
        let env = JobEnv {
            db,
            live,
            songs_dir: songs.to_owned(),
            appdata_dir: appdata.to_owned(),
        };
        let jobs = Jobs::start(env.clone(), Some(String::new())).await.unwrap();
        Scanner::new(env, jobs, Some(String::new()))
    }

    async fn finished(scanner: &Scanner) -> ScanStatus {
        let mut status = scanner.inner.status.subscribe();
        *status.wait_for(|s| !s.running).await.unwrap()
    }

    #[tokio::test]
    async fn a_rescan_while_a_scan_runs_starts_no_second_scan() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let scanner = scanner(songs.path(), appdata.path()).await;

        let first = scanner.request();
        let second = scanner.request();
        assert!(first.running);
        assert!(second.running);
        assert_eq!(second.finished, 0);
        assert_eq!(finished(&scanner).await.finished, 1);

        assert!(scanner.request().running);
        assert_eq!(finished(&scanner).await.finished, 2);
    }

    #[tokio::test]
    async fn no_scan_starts_after_shutdown() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let scanner = scanner(songs.path(), appdata.path()).await;
        scanner.request();
        scanner.shutdown().await;
        assert!(!scanner.status().running);
        assert!(!scanner.request().running);
    }

    #[tokio::test]
    async fn an_unreadable_library_leaves_the_index_alone() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let folder = songs.path().join("A - B");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("x.txt"), b"#BPM:300\n").unwrap();
        let scanner = scanner(songs.path(), appdata.path()).await;
        scanner.request();
        finished(&scanner).await;

        let missing = Scanner::new(
            JobEnv {
                db: scanner.inner.db.clone(),
                live: scanner.inner.live.clone(),
                songs_dir: songs.path().join("not there"),
                appdata_dir: appdata.path().to_owned(),
            },
            scanner.inner.jobs.clone(),
            Some(String::new()),
        );
        missing.request();
        let status = finished(&missing).await;
        assert_eq!(status.finished, 0, "a failed scan reports nothing");
        let problems = missing.inner.db.call(|c| index::problems(c)).await.unwrap();
        assert_eq!(problems.len(), 1);
    }

    fn present(scanner: &Scanner, identity: SongIdentity) -> impl Future<Output = bool> {
        let db = scanner.inner.db.clone();
        async move {
            db.call(move |c| index::identity_present(c, &identity))
                .await
                .unwrap()
        }
    }

    async fn rescanned(scanner: &Scanner) {
        scanner.request();
        finished(scanner).await;
    }

    fn write_song(folder: &std::path::Path, artist: &str, title: &str, duet: bool) {
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join("song.mp3"), b"").unwrap();
        let body = if duet {
            "P1\n: 0 4 0 La\nP2\n: 4 4 2 lo\nE\n"
        } else {
            ": 0 4 0 La\nE\n"
        };
        std::fs::write(
            folder.join("song.txt"),
            format!("#ARTIST:{artist}\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{body}"),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn the_index_answers_whether_an_identity_is_in_the_library() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let folder = songs.path().join("Some Folder");
        write_song(&folder, "The  Band", "Song", false);
        std::fs::write(folder.join("metadata.json"), br#"{"apiId": 42}"#).unwrap();
        write_song(&songs.path().join("Other"), "Ｔhe Band ", "SONG", true);
        let scanner = scanner(songs.path(), appdata.path()).await;
        rescanned(&scanner).await;

        let usdb = SongIdentity::Usdb { usdb_id: 42 };
        let duet = SongIdentity::ArtistTitle {
            artist: "the band".into(),
            title: "song".into(),
            duet: true,
        };
        let solo = SongIdentity::ArtistTitle {
            artist: "the band".into(),
            title: "song".into(),
            duet: false,
        };
        assert!(present(&scanner, usdb.clone()).await);
        assert!(present(&scanner, duet.clone()).await);
        assert!(
            !present(&scanner, solo).await,
            "the Song with a USDB id is not also its artist and title"
        );

        // Moved away: absent. Back under another name: present again.
        let away = appdata.path().join("away");
        std::fs::rename(&folder, &away).unwrap();
        rescanned(&scanner).await;
        assert!(!present(&scanner, usdb.clone()).await);
        assert!(present(&scanner, duet.clone()).await);
        std::fs::create_dir(songs.path().join("Renamed")).unwrap();
        std::fs::rename(&away, songs.path().join("Renamed/Deeper")).unwrap();
        rescanned(&scanner).await;
        assert!(present(&scanner, usdb).await);
    }

    #[tokio::test]
    async fn a_song_that_stops_playing_is_not_present() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let folder = songs.path().join("A");
        write_song(&folder, "A", "B", false);
        let scanner = scanner(songs.path(), appdata.path()).await;
        rescanned(&scanner).await;
        let identity = SongIdentity::ArtistTitle {
            artist: "a".into(),
            title: "b".into(),
            duet: false,
        };
        assert!(present(&scanner, identity.clone()).await);

        std::fs::remove_file(folder.join("song.mp3")).unwrap();
        rescanned(&scanner).await;
        assert!(!present(&scanner, identity.clone()).await);
    }
}
