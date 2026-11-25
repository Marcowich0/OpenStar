//! Storing rounds and Score records through the real app over HTTP, with a
//! temporary appdata. What was stored is read back through
//! `openstar::scores`' read functions over the app's own database file.

use std::time::Duration;

use openstar::scores::{move_identity_in, rounds, stored_snapshot};
use openstar_protocol::UserMessage;
use openstar_protocol::library::{
    ScanStatus, SongDetail, SongId, SongIdentity, SongList, SongSummary,
};
use openstar_protocol::party::PartyId;
use openstar_protocol::profile::{
    Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile, ProfileEdit, ProfileId,
};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, MicKind, NoteFingerprint, PlayerScore, RoundEnd, RoundMode, RoundOutcome,
    ScorePlayer, StoredRound,
};
use openstar_test_harness::TestApp;
use reqwest::StatusCode;

/// A solo Song of two Notes: Beats 0 to 7.
const SOLO: &str = ": 0 4 0 La\n: 4 4 2 lo\nE\n";

fn write_song(app: &TestApp, folder: &str, title: &str, body: &str) {
    let folder = app.songs_dir().join(folder);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("song.mp3"), b"").unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder Artist\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{body}"),
    )
    .unwrap();
}

async fn rescan(app: &TestApp) {
    let before: ScanStatus = app.get_json("/api/library/scan").await;
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let status: ScanStatus = app.get_json("/api/library/scan").await;
        if !status.running && status.finished > before.finished {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "the Rescan hung");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The Song detail of the Song titled `title`.
async fn detail(app: &TestApp, title: &str) -> SongDetail {
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let id = songs
        .iter()
        .find(|s| s.title == title)
        .unwrap_or_else(|| panic!("{title} is not in the Song list"))
        .id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

/// An app with one solo Song in its Library, and that Song's detail.
async fn app_with_song() -> (TestApp, SongDetail) {
    let app = TestApp::start().await;
    write_song(&app, "Solo", "Solo", SOLO);
    rescan(&app).await;
    let song = detail(&app, "Solo").await;
    (app, song)
}

async fn create_profile(app: &TestApp, name: &str) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.into(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::Cherry,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.unwrap()
}

/// Pitches whose decimal forms are long, so a lossy store would show.
fn beat_values() -> Vec<BeatValue> {
    vec![
        BeatValue::NoVoice,
        BeatValue::VoiceWithoutPitch,
        BeatValue::Pitch { pitch: 60.0 },
        BeatValue::Pitch {
            pitch: 61.123_456_789_012_34,
        },
        BeatValue::Pitch {
            pitch: 1.0 / 3.0 + 48.0,
        },
        BeatValue::Pitch {
            pitch: f64::from_bits(0x4051_0000_0000_0001),
        },
        BeatValue::NoVoice,
        BeatValue::Pitch { pitch: 71.999_999 },
    ]
}

fn score(player: ScorePlayer, total: u32) -> PlayerScore {
    PlayerScore {
        player,
        voice: 0,
        difficulty: Difficulty::Hard,
        total,
        notes: total / 2,
        golden: 0,
        line_bonus: total - total / 2,
        mic_kind: MicKind::Phone,
        unfinished: false,
        mic_lost: false,
        beat_range: BeatRange {
            first_beat: 0,
            last_beat: 7,
        },
        beat_values: beat_values(),
    }
}

fn profile(id: ProfileId) -> ScorePlayer {
    ScorePlayer::Profile { profile_id: id }
}

fn guest(name: &str) -> ScorePlayer {
    ScorePlayer::Guest { name: name.into() }
}

fn outcome(song: &SongDetail, ended: RoundEnd, scores: Vec<PlayerScore>) -> RoundOutcome {
    RoundOutcome {
        song_id: song.id,
        note_fingerprint: song.note_fingerprint.clone(),
        party_id: PartyId("party-1".into()),
        mode: RoundMode::Normal,
        started_at_ms: 1_700_000_000_000,
        ended,
        scores,
    }
}

async fn post(app: &TestApp, body: &RoundOutcome) -> (StatusCode, serde_json::Value) {
    let response = app
        .http()
        .post(app.url("/api/rounds"))
        .json(body)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

async fn store(app: &TestApp, body: &RoundOutcome) -> StoredRound {
    let (status, json) = post(app, body).await;
    assert_eq!(status, StatusCode::CREATED, "{json}");
    serde_json::from_value(json).unwrap()
}

fn open_db(app: &TestApp) -> rusqlite::Connection {
    let conn =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .unwrap();
    conn
}

fn stored_rounds(app: &TestApp) -> Vec<StoredRound> {
    rounds(&open_db(app)).unwrap()
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[tokio::test]
async fn the_song_detail_carries_its_note_fingerprint() {
    let (app, song) = app_with_song().await;
    let bytes = std::fs::read(app.songs_dir().join("Solo/song.txt")).unwrap();
    let parsed = openstar::txt::parse(&bytes, "Solo").unwrap();
    assert_eq!(
        song.note_fingerprint,
        openstar::scores::note_fingerprint(&parsed.song)
    );
}

#[tokio::test]
async fn a_played_round_stores_the_round_one_record_per_player_and_the_snapshot() {
    let (app, song) = app_with_song().await;
    let ada = create_profile(&app, "Ada").await;
    let bo = create_profile(&app, "Bo").await;
    let before = now_ms();
    let stored = store(
        &app,
        &outcome(
            &song,
            RoundEnd::Played,
            vec![score(profile(ada.id), 8123), score(profile(bo.id), 0)],
        ),
    )
    .await;
    let after = now_ms();

    assert_eq!(stored.song, song.identity);
    assert_eq!(stored.party_id, PartyId("party-1".into()));
    assert_eq!(stored.mode, RoundMode::Normal);
    assert_eq!(stored.started_at_ms, 1_700_000_000_000);
    assert_eq!(stored.ended, RoundEnd::Played);
    assert_eq!(stored.game_id, None);
    assert_eq!(stored.records.len(), 2, "a Score of 0 is stored too");
    let [first, second] = &stored.records[..] else {
        unreachable!()
    };
    assert_eq!(first.player, profile(ada.id));
    assert_eq!(second.player, profile(bo.id));
    assert_eq!(second.total, 0);
    for record in &stored.records {
        assert_eq!(record.round_id, stored.id);
        assert_eq!(record.party_id, stored.party_id);
        assert_eq!(record.song, song.identity);
        assert_eq!(record.voice, 0);
        assert_eq!(record.difficulty, Difficulty::Hard);
        assert!((before..=after).contains(&record.recorded_at_ms));
        assert_eq!(record.mic_kind, MicKind::Phone);
        assert_eq!(record.mode, RoundMode::Normal);
        assert!(!record.unfinished && !record.mic_lost);
        assert_eq!(
            record.beat_range,
            BeatRange {
                first_beat: 0,
                last_beat: 7
            }
        );
        assert_eq!(record.note_fingerprint, song.note_fingerprint);
    }
    assert_eq!(
        (first.total, first.notes, first.golden, first.line_bonus),
        (8123, 4061, 0, 4062)
    );

    // Read back from the database: every pitch exactly as sent.
    assert_eq!(stored_rounds(&app), vec![stored.clone()]);
    for (got, sent) in first.beat_values.iter().zip(beat_values()) {
        match (got, sent) {
            (BeatValue::Pitch { pitch: got }, BeatValue::Pitch { pitch: sent }) => {
                assert_eq!(got.to_bits(), sent.to_bits());
            }
            (got, sent) => assert_eq!(*got, sent),
        }
    }
    assert_eq!(first.beat_values.len(), 8);

    let snapshot = stored_snapshot(&open_db(&app), &song.note_fingerprint)
        .unwrap()
        .expect("the Note snapshot is stored");
    assert_eq!(
        openstar::scores::fingerprint_of(&snapshot),
        song.note_fingerprint,
        "the snapshot is content-addressed by its fingerprint"
    );
    assert_eq!(snapshot.voices[0].lines[0].notes.len(), 2);

    // The Profile remembers its last Difficulty and when it last sang.
    let ada: Profile = app.get_json(&format!("/api/profiles/{}", ada.id.0)).await;
    assert_eq!(ada.last_difficulty, Difficulty::Hard);
    assert!(
        ada.last_sung_at
            .is_some_and(|t| (before..=after).contains(&t))
    );
}

#[tokio::test]
async fn an_ended_round_keeps_the_unfinished_and_mic_lost_flags_and_the_local_mic() {
    let (app, song) = app_with_song().await;
    let ada = create_profile(&app, "Ada").await;
    let mut sent = score(profile(ada.id), 1200);
    sent.unfinished = true;
    sent.mic_lost = true;
    sent.mic_kind = MicKind::LocalMic;
    sent.difficulty = Difficulty::Easy;
    let stored = store(&app, &outcome(&song, RoundEnd::Ended, vec![sent])).await;
    assert_eq!(stored.ended, RoundEnd::Ended);
    let record = &stored.records[0];
    assert!(record.unfinished && record.mic_lost);
    assert_eq!(record.mic_kind, MicKind::LocalMic);
    assert_eq!(record.difficulty, Difficulty::Easy);
    assert_eq!(stored_rounds(&app), vec![stored]);
}

#[tokio::test]
async fn a_skip_stores_a_skipped_round_and_no_records() {
    let (app, song) = app_with_song().await;
    let stored = store(&app, &outcome(&song, RoundEnd::Skipped, vec![])).await;
    assert_eq!(stored.ended, RoundEnd::Skipped);
    assert!(stored.records.is_empty());
    assert_eq!(stored_rounds(&app), vec![stored]);
    assert_eq!(
        stored_snapshot(&open_db(&app), &song.note_fingerprint).unwrap(),
        None,
        "a skipped round needs no Note snapshot"
    );

    // A skipped round with Scores is refused.
    let ada = create_profile(&app, "Ada").await;
    let (status, json) = post(
        &app,
        &outcome(&song, RoundEnd::Skipped, vec![score(profile(ada.id), 10)]),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{json}");
    assert_eq!(stored_rounds(&app).len(), 1);
}

#[tokio::test]
async fn a_guest_record_has_the_guest_name_and_no_profile() {
    let (app, song) = app_with_song().await;
    let stored = store(
        &app,
        &outcome(&song, RoundEnd::Played, vec![score(guest("Zoë"), 5000)]),
    )
    .await;
    assert_eq!(stored.records[0].player, guest("Zoë"));
    assert_eq!(stored_rounds(&app), vec![stored]);
}

#[tokio::test]
async fn a_note_snapshot_is_stored_once_across_two_rounds() {
    let (app, song) = app_with_song().await;
    for total in [100, 200] {
        store(
            &app,
            &outcome(&song, RoundEnd::Played, vec![score(guest("Zoë"), total)]),
        )
        .await;
    }
    let conn = open_db(&app);
    let snapshots: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(snapshots, 1);
    assert_eq!(rounds(&conn).unwrap().len(), 2);
}

#[tokio::test]
async fn a_failed_store_leaves_nothing_behind() {
    let (app, song) = app_with_song().await;
    let ada = create_profile(&app, "Ada").await;

    // The second record names a Profile that does not exist.
    let (status, json) = post(
        &app,
        &outcome(
            &song,
            RoundEnd::Played,
            vec![
                score(profile(ada.id), 10),
                score(profile(ProfileId(999)), 20),
            ],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{json}");
    assert_eq!(
        serde_json::from_value::<UserMessage>(json).unwrap(),
        UserMessage::ProfileNotFound
    );

    // A record whose Beat values do not fill its Beat range.
    let mut short = score(guest("Zoë"), 10);
    short.beat_values.pop();
    let (status, _) = post(&app, &outcome(&song, RoundEnd::Played, vec![short])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // A Voice the Song does not have.
    let mut voice = score(guest("Zoë"), 10);
    voice.voice = 1;
    let (status, _) = post(&app, &outcome(&song, RoundEnd::Played, vec![voice])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Parts that do not add up to the total.
    let mut parts = score(guest("Zoë"), 10);
    parts.golden = 1;
    let (status, _) = post(&app, &outcome(&song, RoundEnd::Played, vec![parts])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // A fingerprint that is not the Song's.
    let mut other = outcome(&song, RoundEnd::Played, vec![score(guest("Zoë"), 10)]);
    other.note_fingerprint = NoteFingerprint("0".repeat(64));
    let (status, json) = post(&app, &other).await;
    assert_eq!(status, StatusCode::CONFLICT, "{json}");

    // A Song that is not in the Library.
    let mut gone = outcome(&song, RoundEnd::Skipped, vec![]);
    gone.song_id = SongId(9999);
    let (status, _) = post(&app, &gone).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    assert_eq!(stored_rounds(&app), vec![]);
    assert_eq!(
        stored_snapshot(&open_db(&app), &song.note_fingerprint).unwrap(),
        None
    );
    let ada: Profile = app.get_json(&format!("/api/profiles/{}", ada.id.0)).await;
    assert_eq!(
        ada.last_sung_at, None,
        "the Profile's last sung is untouched"
    );
}

#[tokio::test]
async fn nothing_limits_records_per_round_or_per_profile() {
    let (app, song) = app_with_song().await;
    let ada = create_profile(&app, "Ada").await;
    let scores = (0..6)
        .map(|i| {
            if i < 2 {
                score(profile(ada.id), 100 + i)
            } else {
                score(guest("Zoë"), 100 + i)
            }
        })
        .collect();
    let stored = store(&app, &outcome(&song, RoundEnd::Played, scores)).await;
    assert_eq!(stored.records.len(), 6);
    let totals: Vec<u32> = stored.records.iter().map(|r| r.total).collect();
    assert_eq!(totals, [100, 101, 102, 103, 104, 105], "in the order sent");
}

#[tokio::test]
async fn deleting_a_profile_deletes_its_records_and_renaming_keeps_them() {
    let (app, song) = app_with_song().await;
    let ada = create_profile(&app, "Ada").await;
    let bo = create_profile(&app, "Bo").await;
    store(
        &app,
        &outcome(
            &song,
            RoundEnd::Played,
            vec![score(profile(ada.id), 10), score(profile(bo.id), 20)],
        ),
    )
    .await;

    let response = app
        .http()
        .patch(app.url(&format!("/api/profiles/{}", ada.id.0)))
        .json(&ProfileEdit {
            name: Some("Ada Renamed".into()),
            ..ProfileEdit::default()
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let players = |app: &TestApp| -> Vec<ScorePlayer> {
        stored_rounds(app)[0]
            .records
            .iter()
            .map(|r| r.player.clone())
            .collect()
    };
    assert_eq!(players(&app), [profile(ada.id), profile(bo.id)]);

    // No delete endpoint exists yet (Admin area); delete the row as it will.
    open_db(&app)
        .execute("DELETE FROM profiles WHERE id = ?1", [bo.id.0])
        .unwrap();
    assert_eq!(players(&app), [profile(ada.id)]);
}

#[tokio::test]
async fn the_identity_move_moves_every_record_of_one_key_inside_the_callers_transaction() {
    let app = TestApp::start().await;
    write_song(&app, "Old", "Old Title", SOLO);
    write_song(&app, "Other", "Other Title", SOLO);
    rescan(&app).await;
    let old = detail(&app, "Old Title").await;
    let other = detail(&app, "Other Title").await;
    for song in [&old, &old, &other] {
        store(
            &app,
            &outcome(song, RoundEnd::Played, vec![score(guest("Zoë"), 10)]),
        )
        .await;
    }
    let new = SongIdentity::ArtistTitle {
        artist: "placeholder artist".into(),
        title: "new title".into(),
        duet: false,
    };

    let mut conn = open_db(&app);
    // Rolled back: nothing moves.
    let tx = conn.transaction().unwrap();
    assert_eq!(move_identity_in(&tx, &old.identity, &new).unwrap(), 2);
    tx.rollback().unwrap();
    assert!(rounds(&conn).unwrap().iter().all(|round| round.song != new));
    // Committed: both rounds of the old key and their records move.
    let tx = conn.transaction().unwrap();
    move_identity_in(&tx, &old.identity, &new).unwrap();
    tx.commit().unwrap();

    let songs: Vec<SongIdentity> = rounds(&conn)
        .unwrap()
        .iter()
        .flat_map(|round| {
            std::iter::once(round.song.clone()).chain(round.records.iter().map(|r| r.song.clone()))
        })
        .collect();
    assert_eq!(
        songs,
        [
            new.clone(),
            new.clone(),
            new.clone(),
            new,
            other.identity.clone(),
            other.identity
        ]
    );
}
