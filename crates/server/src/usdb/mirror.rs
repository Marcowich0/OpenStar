//! The USDB mirror: USDB's song list kept in SQLite, so searching USDB never
//! costs USDB a request.
//!
//! Two job kinds fill it, both in the one-at-a-time
//! [`Lane::UsdbMirror`](crate::jobs::Lane::UsdbMirror) and both through the [`UsdbClient`]'s queue, so
//! pacing and backoff hold for them as for every other USDB request:
//!
//! - **Full refetch** ([`refetch`]): every list page of 100 songs, newest
//!   change first, until a page has fewer than 100 rows. Each page is stored
//!   as it arrives, so search works on what is mirrored so far. Then it reads
//!   the list's head again for songs that changed while it ran (they moved to
//!   the top, past where it was reading), and finally drops every song it did
//!   not see: USDB no longer has it. The first fill is a full refetch of an
//!   empty mirror; it also runs weekly and by hand.
//! - **Update** ([`update`]): list pages newest change first, stopping at the
//!   first row older than the newest change already mirrored.
//!
//! When a run starts is decided by [`Due`]: at every start an update (a full
//! refetch while the first fill has not finished, or once a week has passed);
//! when the Downloads section asks, only if the mirror is more than a day
//! old; on the hourly schedule, only a due full refetch. Without USDB
//! credentials nothing runs and [`Mirror::status`] says why.

use std::sync::Arc;
use std::time::Duration;

use openstar_protocol::jobs::{JobKind, JobState};
use openstar_protocol::usdb::{UsdbMirrorState, UsdbMirrorStatus, UsdbState};
use openstar_protocol::{ChangeTopic, UserMessage};
use rusqlite::{OptionalExtension, params};

use super::{SongListRow, UsdbClient, parse_song_list, parse_song_list_total};
use crate::clock::Clock;
use crate::db::Database;
use crate::jobs::{JobContext, JobParams, Jobs};

/// How often the server checks whether the weekly full refetch is due.
pub const SCHEDULE_CHECK: Duration = Duration::from_secs(60 * 60);
/// How long a refreshed mirror counts as fresh.
pub const FRESH_FOR: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the full refetch runs.
pub const REFETCH_EVERY: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Rows per list page (`limit`).
const PAGE_ROWS: u32 = 100;
/// The list order both runs read in: newest change first.
const ORDER: &str = "lastchange";
const DESCENDING: &str = "desc";

/// Who asks for a mirror run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ask {
    /// The server started (and logged in).
    Start,
    /// The Downloads section opened.
    Request,
    /// The hourly schedule.
    Schedule,
    /// Someone started a full refetch by hand.
    Refetch,
}

/// Which run an [`Ask`] starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Due {
    Nothing,
    Update,
    Refetch,
}

/// The mirror's own facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Facts {
    pub(crate) last_refreshed_ms: Option<i64>,
    pub(crate) last_full_ms: Option<i64>,
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl Due {
    /// The run `ask` starts at `now_ms`, given the mirror's `facts`.
    pub(crate) fn of(ask: Ask, facts: Facts, now_ms: i64) -> Self {
        let older_than = |at: Option<i64>, age: Duration| {
            at.is_none_or(|at| now_ms.saturating_sub(at) > millis(age))
        };
        let refetch_due = older_than(facts.last_full_ms, REFETCH_EVERY);
        match ask {
            Ask::Refetch => Self::Refetch,
            _ if refetch_due => Self::Refetch,
            Ask::Start => Self::Update,
            Ask::Request if older_than(facts.last_refreshed_ms, FRESH_FOR) => Self::Update,
            Ask::Request | Ask::Schedule => Self::Nothing,
        }
    }
}

fn is_mirror_kind(kind: JobKind) -> bool {
    matches!(kind, JobKind::UsdbMirrorRefetch | JobKind::UsdbMirrorUpdate)
}

/// The mirror, as handlers and the server's start see it. Built on demand
/// from the app state (`AppState::mirror`).
pub(crate) struct Mirror {
    pub(crate) db: Database,
    pub(crate) jobs: Jobs,
    pub(crate) usdb: UsdbClient,
    pub(crate) clock: Clock,
    /// Held while deciding whether to queue a run.
    pub(crate) gate: Arc<tokio::sync::Mutex<()>>,
}

impl Mirror {
    /// At start, once logged in.
    pub(crate) async fn at_start(&self) {
        self.log_failure(self.ask(Ask::Start).await);
    }

    /// The hourly check for the weekly full refetch.
    pub(crate) async fn on_schedule(&self) {
        self.log_failure(self.ask(Ask::Schedule).await);
    }

    fn log_failure(&self, result: anyhow::Result<()>) {
        if let Err(error) = result {
            tracing::error!(?error, "starting a USDB mirror run");
        }
    }

    /// Queues the run `ask` is due for, unless USDB has no credentials or a
    /// mirror run is already queued or running.
    pub(crate) async fn ask(&self, ask: Ask) -> anyhow::Result<()> {
        if self.usdb.status() == UsdbState::CredentialsMissing {
            return Ok(());
        }
        let _gate = self.gate.lock().await;
        let jobs = self.jobs.list().await.unwrap_or_default();
        if jobs
            .iter()
            .any(|job| is_mirror_kind(job.kind) && is_unfinished(&job.state))
        {
            return Ok(());
        }
        let facts = self.db.call(store::facts).await?;
        let params = match Due::of(ask, facts, self.clock.now_millis()) {
            Due::Nothing => return Ok(()),
            Due::Update => JobParams::UsdbMirrorUpdate,
            Due::Refetch => JobParams::UsdbMirrorRefetch,
        };
        tracing::info!(?ask, kind = ?params.kind(), "starting a USDB mirror run");
        self.jobs.enqueue(params).await?;
        Ok(())
    }

    /// Where the mirror stands.
    pub(crate) async fn status(&self) -> anyhow::Result<UsdbMirrorStatus> {
        // The jobs are read before the stored facts. The other way round, a
        // run that ends between the two reads shows as neither running nor
        // refreshed: a mirror that was just refreshed would read as stale.
        let latest = self
            .jobs
            .list()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|job| is_mirror_kind(job.kind))
            .max_by_key(|job| job.id);
        let (facts, songs) = self
            .db
            .call(|conn| Ok((store::facts(conn)?, store::count(conn)?)))
            .await?;
        let last_failure = match &latest {
            Some(job) => match &job.state {
                JobState::Failed { reason } => Some(reason.clone()),
                _ => None,
            },
            None => None,
        };
        let running = latest.as_ref().and_then(|job| match job.state {
            JobState::Queued => Some((job.kind, None)),
            JobState::Running { percent } => Some((job.kind, percent)),
            JobState::Done | JobState::Failed { .. } => None,
        });
        let now_ms = self.clock.now_millis();
        let state = if self.usdb.status() == UsdbState::CredentialsMissing {
            UsdbMirrorState::Unavailable {
                reason: UserMessage::UsdbCredentialsMissing,
            }
        } else if let Some((kind, percent)) = running {
            if facts.last_full_ms.is_none() {
                UsdbMirrorState::Filling { percent }
            } else {
                UsdbMirrorState::Refreshing {
                    full: kind == JobKind::UsdbMirrorRefetch,
                    percent,
                }
            }
        } else if facts.last_full_ms.is_none() {
            if songs == 0 {
                UsdbMirrorState::Empty
            } else {
                UsdbMirrorState::Incomplete
            }
        } else if facts
            .last_refreshed_ms
            .is_some_and(|at| now_ms.saturating_sub(at) <= millis(FRESH_FOR))
        {
            UsdbMirrorState::Fresh
        } else {
            UsdbMirrorState::Stale
        };
        Ok(UsdbMirrorStatus {
            state,
            songs,
            last_refreshed_ms: facts.last_refreshed_ms,
            last_full_ms: facts.last_full_ms,
            last_failure,
        })
    }
}

fn is_unfinished(state: &JobState) -> bool {
    matches!(state, JobState::Queued | JobState::Running { .. })
}

/// What a mirror run uses.
struct Run<'a> {
    ctx: &'a JobContext,
    usdb: UsdbClient,
    clock: Clock,
}

impl<'a> Run<'a> {
    fn new(ctx: &'a JobContext) -> Result<Self, UserMessage> {
        let Some(env) = ctx.usdb.clone() else {
            tracing::error!("a USDB mirror job ran without a USDB client");
            return Err(UserMessage::ServerError);
        };
        Ok(Self {
            ctx,
            usdb: env.usdb,
            clock: env.clock,
        })
    }

    fn db(&self) -> &Database {
        &self.ctx.env.db
    }

    /// One list page's rows (and the list's total when the page says it);
    /// ends at once when the job is cancelled.
    async fn page(&self, start: u32) -> Result<(Vec<SongListRow>, Option<u32>), UserMessage> {
        let html = tokio::select! {
            html = self.usdb.song_list_page(start, ORDER, DESCENDING) => html?,
            () = self.ctx.slot.cancelled() => return Err(UserMessage::JobCancelled),
        };
        Ok((parse_song_list(&html), parse_song_list_total(&html)))
    }

    /// Stores rows as seen by refetch number `refetch`, and tells browsers.
    async fn store(&self, rows: Vec<SongListRow>, refetch: i64) -> Result<(), UserMessage> {
        if rows.is_empty() {
            return Ok(());
        }
        self.db()
            .call(move |conn| store::put(conn, &rows, refetch))
            .await
            .map_err(server_error("storing USDB list rows"))?;
        self.changed().await;
        Ok(())
    }

    async fn changed(&self) {
        self.ctx
            .env
            .live
            .changed(vec![ChangeTopic::UsdbMirror])
            .await;
    }

    /// Reads list pages from the top and stores each row until the first one
    /// older than `stop_below` (every row when `None`) or the list's end.
    async fn read_head(&self, stop_below: Option<i64>, refetch: i64) -> Result<(), UserMessage> {
        let mut start = 0;
        loop {
            let (rows, _) = self.page(start).await?;
            let full_page = rows.len() >= PAGE_ROWS as usize;
            let read = rows.len();
            let newer: Vec<SongListRow> = rows
                .into_iter()
                .take_while(|row| stop_below.is_none_or(|stop| row.last_change >= stop))
                .collect();
            let reached_older = newer.len() < read;
            self.store(newer, refetch).await?;
            if !full_page || reached_older {
                return Ok(());
            }
            start += PAGE_ROWS;
        }
    }

    async fn finish(&self, full: bool) -> Result<(), UserMessage> {
        let now_ms = self.clock.now_millis();
        self.db()
            .call(move |conn| store::finish(conn, full, now_ms))
            .await
            .map_err(server_error("storing the end of a USDB mirror run"))?;
        self.changed().await;
        Ok(())
    }
}

fn server_error(doing: &'static str) -> impl Fn(anyhow::Error) -> UserMessage {
    move |error| {
        tracing::error!(?error, "{doing}");
        UserMessage::ServerError
    }
}

/// The full refetch job (see the module docs).
pub(crate) async fn refetch(ctx: &mut JobContext) -> Result<(), UserMessage> {
    let run = Run::new(ctx)?;
    let (refetch, before) = run
        .db()
        .call(|conn| Ok((store::begin_refetch(conn)?, store::count(conn)?)))
        .await
        .map_err(server_error("starting a USDB refetch"))?;
    run.changed().await;
    let mut start = 0;
    let mut seen: u32 = 0;
    let mut newest = None;
    loop {
        let (rows, total) = run.page(start).await?;
        let full_page = rows.len() >= PAGE_ROWS as usize;
        newest = newest.or(rows.first().map(|row| row.last_change));
        seen += u32::try_from(rows.len()).unwrap_or(u32::MAX);
        run.store(rows, refetch).await?;
        if let Some(total) = total.or((before > 0).then_some(before)) {
            let percent = (u64::from(seen) * 100 / u64::from(total.max(1))).min(99);
            ctx.progress.report(u8::try_from(percent).unwrap_or(99));
        }
        if !full_page {
            break;
        }
        start += PAGE_ROWS;
    }
    // Songs that changed while this ran moved to the top, above where it
    // was reading: read them again so they count as seen.
    if let Some(newest) = newest {
        run.read_head(Some(newest), refetch).await?;
    }
    if seen == 0 {
        // An empty list is far likelier a page USDB changed than USDB
        // without songs: keep what is mirrored.
        tracing::warn!("USDB's song list read empty: no mirrored song is dropped");
    } else {
        let dropped = run
            .db()
            .call(move |conn| store::drop_unseen(conn, refetch))
            .await
            .map_err(server_error("dropping songs USDB no longer has"))?;
        tracing::info!(songs = seen, dropped, "USDB mirror refetched");
    }
    run.finish(true).await
}

/// The update job (see the module docs).
pub(crate) async fn update(ctx: &mut JobContext) -> Result<(), UserMessage> {
    let run = Run::new(ctx)?;
    let (newest, refetch) = run
        .db()
        .call(|conn| Ok((store::newest(conn)?, store::facts_refetch(conn)?)))
        .await
        .map_err(server_error("starting a USDB mirror update"))?;
    run.read_head(newest, refetch).await?;
    run.finish(false).await
}

/// The mirror's tables (`usdb_songs`, `usdb_mirror`; see `db.rs`).
mod store {
    use super::{Facts, OptionalExtension, SongListRow, params};

    pub(super) fn facts(conn: &mut rusqlite::Connection) -> rusqlite::Result<Facts> {
        conn.query_row(
            "SELECT last_refreshed_ms, last_full_ms FROM usdb_mirror WHERE id = 1",
            [],
            |row| {
                Ok(Facts {
                    last_refreshed_ms: row.get(0)?,
                    last_full_ms: row.get(1)?,
                })
            },
        )
    }

    pub(super) fn facts_refetch(conn: &mut rusqlite::Connection) -> rusqlite::Result<i64> {
        conn.query_row("SELECT refetch FROM usdb_mirror WHERE id = 1", [], |row| {
            row.get(0)
        })
    }

    pub(super) fn count(conn: &mut rusqlite::Connection) -> rusqlite::Result<u32> {
        conn.query_row("SELECT COUNT(*) FROM usdb_songs", [], |row| row.get(0))
    }

    pub(super) fn newest(conn: &mut rusqlite::Connection) -> rusqlite::Result<Option<i64>> {
        Ok(conn
            .query_row("SELECT MAX(last_change) FROM usdb_songs", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .optional()?
            .flatten())
    }

    /// Numbers a new full refetch.
    pub(super) fn begin_refetch(conn: &mut rusqlite::Connection) -> rusqlite::Result<i64> {
        conn.query_row(
            "UPDATE usdb_mirror SET refetch = refetch + 1 WHERE id = 1 RETURNING refetch",
            [],
            |row| row.get(0),
        )
    }

    /// Adds or updates rows, in one transaction.
    pub(super) fn put(
        conn: &mut rusqlite::Connection,
        rows: &[SongListRow],
        refetch: i64,
    ) -> rusqlite::Result<()> {
        let tx = conn.transaction()?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO usdb_songs (usdb_id, artist, title, genre, year, edition, golden,
                     language, creator, rating, views, last_change, refetch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT (usdb_id) DO UPDATE SET
                     artist = excluded.artist, title = excluded.title,
                     genre = excluded.genre, year = excluded.year,
                     edition = excluded.edition, golden = excluded.golden,
                     language = excluded.language, creator = excluded.creator,
                     rating = excluded.rating, views = excluded.views,
                     last_change = excluded.last_change, refetch = excluded.refetch",
            )?;
            for row in rows {
                insert.execute(params![
                    row.id,
                    row.artist,
                    row.title,
                    row.genre,
                    row.year,
                    row.edition,
                    row.golden,
                    row.language,
                    row.creator,
                    f64::from(row.rating),
                    row.views,
                    row.last_change,
                    refetch,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Drops the songs refetch number `refetch` did not see.
    pub(super) fn drop_unseen(
        conn: &mut rusqlite::Connection,
        refetch: i64,
    ) -> rusqlite::Result<usize> {
        conn.execute(
            "DELETE FROM usdb_songs WHERE refetch <> ?1",
            params![refetch],
        )
    }

    /// Every mirrored song, by id.
    #[cfg(test)]
    pub(super) fn songs(conn: &mut rusqlite::Connection) -> rusqlite::Result<Vec<SongListRow>> {
        let mut select = conn.prepare(
            "SELECT usdb_id, artist, title, genre, year, edition, golden, language, creator,
                 rating, views, last_change
             FROM usdb_songs ORDER BY usdb_id",
        )?;
        select
            .query_map([], |row| {
                Ok(SongListRow {
                    id: row.get(0)?,
                    artist: row.get(1)?,
                    title: row.get(2)?,
                    genre: row.get(3)?,
                    year: row.get(4)?,
                    edition: row.get(5)?,
                    golden: row.get(6)?,
                    language: row.get(7)?,
                    creator: row.get(8)?,
                    #[expect(clippy::cast_possible_truncation, reason = "0 to 5 in halves")]
                    rating: row.get::<_, f64>(9)? as f32,
                    views: row.get(10)?,
                    last_change: row.get(11)?,
                })
            })?
            .collect()
    }

    pub(super) fn finish(
        conn: &mut rusqlite::Connection,
        full: bool,
        now_ms: i64,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "UPDATE usdb_mirror SET last_refreshed_ms = ?1,
                 last_full_ms = CASE WHEN ?2 THEN ?1 ELSE last_full_ms END
             WHERE id = 1",
            params![now_ms, full],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60 * 1000;
    const NOW: i64 = 1_000 * DAY;

    fn facts(refreshed_days_ago: Option<i64>, full_days_ago: Option<i64>) -> Facts {
        Facts {
            last_refreshed_ms: refreshed_days_ago.map(|d| NOW - d * DAY),
            last_full_ms: full_days_ago.map(|d| NOW - d * DAY),
        }
    }

    #[test]
    fn an_unfilled_mirror_gets_a_full_refetch_whoever_asks() {
        for ask in [Ask::Start, Ask::Request, Ask::Schedule, Ask::Refetch] {
            assert_eq!(
                Due::of(ask, facts(None, None), NOW),
                Due::Refetch,
                "{ask:?}"
            );
            assert_eq!(
                Due::of(ask, facts(Some(0), None), NOW),
                Due::Refetch,
                "{ask:?}"
            );
        }
    }

    #[test]
    fn every_start_updates_a_filled_mirror() {
        assert_eq!(
            Due::of(Ask::Start, facts(Some(0), Some(1)), NOW),
            Due::Update
        );
    }

    #[test]
    fn the_downloads_section_updates_only_a_mirror_more_than_a_day_old() {
        assert_eq!(
            Due::of(Ask::Request, facts(Some(0), Some(3)), NOW),
            Due::Nothing
        );
        assert_eq!(
            Due::of(Ask::Request, facts(Some(1), Some(3)), NOW),
            Due::Nothing
        );
        let just_over = Facts {
            last_refreshed_ms: Some(NOW - DAY - 1),
            last_full_ms: Some(NOW - 3 * DAY),
        };
        assert_eq!(Due::of(Ask::Request, just_over, NOW), Due::Update);
    }

    #[test]
    fn a_week_after_the_last_full_refetch_another_is_due() {
        assert_eq!(
            Due::of(Ask::Schedule, facts(Some(0), Some(6)), NOW),
            Due::Nothing
        );
        let a_week = Facts {
            last_refreshed_ms: Some(NOW),
            last_full_ms: Some(NOW - 7 * DAY - 1),
        };
        assert_eq!(Due::of(Ask::Schedule, a_week, NOW), Due::Refetch);
        assert_eq!(Due::of(Ask::Start, a_week, NOW), Due::Refetch);
        assert_eq!(Due::of(Ask::Request, a_week, NOW), Due::Refetch);
    }

    #[tokio::test]
    async fn the_mirror_stores_every_list_field_and_a_refetch_drops_unseen_songs() {
        let appdata = tempfile::tempdir().unwrap();
        let db = Database::open(appdata.path()).await.unwrap().database;
        let rows = super::parse_song_list(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../fixtures/usdb/list.html"),
            )
            .unwrap(),
        );
        assert_eq!(rows.len(), 3);
        let stored = rows.clone();
        let (first, songs) = db
            .call(move |conn| {
                let first = store::begin_refetch(conn)?;
                store::put(conn, &stored, first)?;
                Ok((first, store::songs(conn)?))
            })
            .await
            .unwrap();
        assert_eq!(
            songs, rows,
            "every field, the id and the last change included"
        );

        // A later refetch sees only song 2 (now changed): the others go.
        let mut changed = rows[1].clone();
        changed.title = "Changed".to_owned();
        changed.last_change += 10;
        let seen = vec![changed.clone()];
        let (second, dropped, songs, newest) = db
            .call(move |conn| {
                let second = store::begin_refetch(conn)?;
                store::put(conn, &seen, second)?;
                let dropped = store::drop_unseen(conn, second)?;
                Ok((second, dropped, store::songs(conn)?, store::newest(conn)?))
            })
            .await
            .unwrap();
        assert_eq!(second, first + 1);
        assert_eq!(dropped, 2);
        assert_eq!(songs, [changed.clone()]);
        assert_eq!(newest, Some(changed.last_change));
    }

    #[test]
    fn a_refetch_by_hand_runs_whatever_the_age() {
        assert_eq!(
            Due::of(Ask::Refetch, facts(Some(0), Some(0)), NOW),
            Due::Refetch
        );
    }
}
