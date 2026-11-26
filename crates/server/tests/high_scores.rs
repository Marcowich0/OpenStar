//! High scores through the real app over HTTP: the "new high score" flag on
//! stored records, a Song's top-10 tables (`GET /api/songs/{id}/high-scores`),
//! each Song row's top High score (`GET /api/songs`), the "older timing" mark,
//! and records hidden while their Song is not in the Library.

use std::time::Duration;

use openstar_protocol::library::{ScanStatus, SongDetail, SongList, SongSummary};
use openstar_protocol::party::{PartyId, RequestId};
use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, HighScoreHolder, HighScoreTable, MicKind, PlayerScore, RoundEnd,
    RoundMode, RoundOutcome, ScorePlayer, SongHighScores, StoredRound, TopHighScore,
};
use openstar_test_harness::TestApp;

/// A Request id no other round of these tests has: a round is stored once
/// per (Party, Request).
fn next_request() -> RequestId {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    RequestId(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}
use reqwest::StatusCode;

/// A solo Song of two Notes: Beats 0 to 7.
const SOLO: &str = ": 0 4 0 La\n: 4 4 2 lo\nE\n";
/// The same Song after a Timing edit: the second Note starts one Beat later.
const SOLO_RETIMED: &str = ": 0 4 0 La\n: 5 4 2 lo\nE\n";
/// A duet: Voice 0 sings Beats 0 to 3, Voice 1 Beats 4 to 7.
const DUET: &str = "P1\n: 0 4 0 La\nP2\n: 4 4 2 lo\nE\n";

fn write_song(app: &TestApp, folder: &str, title: &str, body: &str) {
    let folder = app.songs_dir().join(folder);
    std::fs::create_dir_all(&folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
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

async fn rows(app: &TestApp) -> Vec<SongSummary> {
    app.get_json::<SongList>("/api/songs").await.songs
}

async fn row(app: &TestApp, title: &str) -> Option<SongSummary> {
    rows(app).await.into_iter().find(|s| s.title == title)
}

async fn detail(app: &TestApp, title: &str) -> SongDetail {
    let id = row(app, title)
        .await
        .unwrap_or_else(|| panic!("{title} is not in the Song list"))
        .id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

async fn add_song(app: &TestApp, folder: &str, title: &str, body: &str) -> SongDetail {
    write_song(app, folder, title, body);
    rescan(app).await;
    detail(app, title).await
}

async fn create_profile(app: &TestApp, name: &str, colour: PaletteKey) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.into(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: colour,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.unwrap()
}

/// `n` Profiles named `P01`, `P02`, … with palette colours in turn.
async fn profiles(app: &TestApp, n: usize) -> Vec<Profile> {
    let mut all = Vec::new();
    for i in 0..n {
        let colour = PaletteKey::ALL[i % PaletteKey::ALL.len()];
        all.push(create_profile(app, &format!("P{:02}", i + 1), colour).await);
    }
    all
}

fn holder(profile: &Profile) -> HighScoreHolder {
    HighScoreHolder {
        profile_id: profile.id,
        name: profile.name.clone(),
        avatar: profile.avatar,
        favourite_colour: profile.favourite_colour,
    }
}

/// A Finished Hard Score on Voice 0 covering Beats 0 to 7.
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
        beat_values: vec![BeatValue::Pitch { pitch: 60.0 }; 8],
    }
}

fn on_voice(mut score: PlayerScore, voice: u32) -> PlayerScore {
    let first_beat = if voice == 0 { 0 } else { 4 };
    score.voice = voice;
    score.beat_range = BeatRange {
        first_beat,
        last_beat: first_beat + 3,
    };
    score.beat_values.truncate(4);
    score
}

fn at(mut score: PlayerScore, difficulty: Difficulty) -> PlayerScore {
    score.difficulty = difficulty;
    score
}

fn unfinished(mut score: PlayerScore) -> PlayerScore {
    score.unfinished = true;
    score
}

fn mic_lost(mut score: PlayerScore) -> PlayerScore {
    score.mic_lost = true;
    score
}

fn of(profile: &Profile) -> ScorePlayer {
    ScorePlayer::Profile {
        profile_id: profile.id,
    }
}

fn guest(name: &str) -> ScorePlayer {
    ScorePlayer::Guest { name: name.into() }
}

async fn store(app: &TestApp, song: &SongDetail, scores: Vec<PlayerScore>) -> StoredRound {
    let outcome = RoundOutcome {
        song_id: song.id,
        note_fingerprint: song.note_fingerprint.clone(),
        request_id: next_request(),
        party_id: PartyId("party-1".into()),
        mode: RoundMode::Normal,
        started_at_ms: 1_700_000_000_000,
        ended: RoundEnd::Played,
        scores,
    };
    let response = app
        .http()
        .post(app.url("/api/test/rounds"))
        .json(&outcome)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(status, StatusCode::CREATED, "{json}");
    serde_json::from_value(json).unwrap()
}

async fn high_scores(app: &TestApp, song: &SongDetail) -> SongHighScores {
    app.get_json(&format!("/api/songs/{}/high-scores", song.id.0))
        .await
}

fn table(scores: &SongHighScores, voice: u32, difficulty: Difficulty) -> &HighScoreTable {
    scores
        .tables
        .iter()
        .find(|t| t.voice == voice && t.difficulty == difficulty)
        .unwrap_or_else(|| panic!("no table for Voice {voice} {difficulty:?}"))
}

/// (place, name, total) of each entry of the Hard table of Voice 0.
async fn hard_table(app: &TestApp, song: &SongDetail) -> Vec<(u32, String, u32)> {
    let scores = high_scores(app, song).await;
    table(&scores, 0, Difficulty::Hard)
        .entries
        .iter()
        .map(|e| (e.place, e.holder.name.clone(), e.total))
        .collect()
}

fn flags(round: &StoredRound) -> Vec<bool> {
    round.records.iter().map(|r| r.new_high_score).collect()
}

#[tokio::test]
async fn a_solo_song_has_one_table_per_difficulty_and_a_duet_two_voices_each() {
    let app = TestApp::builder().test_routes().start().await;
    let solo = add_song(&app, "Solo", "Solo", SOLO).await;
    let duet = add_song(&app, "Duet", "Duet", DUET).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    // Only Voice 0 of the duet was sung.
    store(&app, &duet, vec![on_voice(score(of(&ada), 5000), 0)]).await;

    let keys = |scores: &SongHighScores| -> Vec<(u32, Difficulty, usize)> {
        scores
            .tables
            .iter()
            .map(|t| (t.voice, t.difficulty, t.entries.len()))
            .collect()
    };
    use Difficulty::{Easy, Hard, Medium};
    assert_eq!(
        keys(&high_scores(&app, &solo).await),
        vec![(0, Easy, 0), (0, Medium, 0), (0, Hard, 0)]
    );
    assert_eq!(
        keys(&high_scores(&app, &duet).await),
        vec![
            (0, Easy, 0),
            (0, Medium, 0),
            (0, Hard, 1),
            (1, Easy, 0),
            (1, Medium, 0),
            (1, Hard, 0),
        ],
        "a duet's two Voices are separate tables even when one was sung"
    );
}

#[tokio::test]
async fn an_unknown_song_has_no_high_scores() {
    let app = TestApp::builder().test_routes().start().await;
    let response = app
        .http()
        .get(app.url("/api/songs/999999/high-scores"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_table_shows_the_top_ten_profiles_once_each_with_their_best_counted_record() {
    let app = TestApp::builder().test_routes().start().await;
    let song = add_song(&app, "Solo", "Solo", SOLO).await;
    let people = profiles(&app, 12).await;
    // P01's best is 9000 (its 9500 is unfinished and its later 8000 lower).
    store(&app, &song, vec![score(of(&people[0]), 9000)]).await;
    store(&app, &song, vec![unfinished(score(of(&people[0]), 9500))]).await;
    store(&app, &song, vec![score(of(&people[0]), 8000)]).await;
    // P02 to P12 score 8900, 8800, …, 7900; P12 falls off the table.
    for (i, person) in people.iter().enumerate().skip(1) {
        let total = 9000 - 100 * u32::try_from(i).unwrap();
        store(&app, &song, vec![score(of(person), total)]).await;
    }
    // Excluded: a Guest, a 0-point record, another Difficulty, another Voice.
    store(&app, &song, vec![score(guest("Gus"), 9999)]).await;
    let zero = create_profile(&app, "Zero", PaletteKey::Cherry).await;
    store(&app, &song, vec![score(of(&zero), 0)]).await;
    store(
        &app,
        &song,
        vec![at(score(of(&zero), 9999), Difficulty::Easy)],
    )
    .await;
    // A mic lost record counts.
    let lost = create_profile(&app, "Lost", PaletteKey::Cherry).await;
    store(&app, &song, vec![mic_lost(score(of(&lost), 8450))]).await;

    let scores = high_scores(&app, &song).await;
    let hard = table(&scores, 0, Difficulty::Hard);
    let names: Vec<(&str, u32)> = hard
        .entries
        .iter()
        .map(|e| (e.holder.name.as_str(), e.total))
        .collect();
    assert_eq!(
        names,
        vec![
            ("P01", 9000),
            ("P02", 8900),
            ("P03", 8800),
            ("P04", 8700),
            ("P05", 8600),
            ("P06", 8500),
            ("Lost", 8450),
            ("P07", 8400),
            ("P08", 8300),
            ("P09", 8200),
        ]
    );
    assert_eq!(
        hard.entries[0].holder,
        holder(&people[0]),
        "an entry carries the Profile's name, avatar and favourite colour"
    );
    assert_eq!(hard.entries[1].holder.favourite_colour, PaletteKey::ALL[1]);
    assert_eq!(
        hard.entries.iter().map(|e| e.place).collect::<Vec<_>>(),
        (1..=10).collect::<Vec<u32>>()
    );
    assert!(hard.entries.iter().all(|e| !e.older_timing));
    let easy = table(&scores, 0, Difficulty::Easy);
    assert_eq!(easy.entries.len(), 1);
    assert_eq!(easy.entries[0].holder.name, "Zero");
}

#[tokio::test]
async fn equal_totals_share_a_place_and_the_next_place_skips() {
    let app = TestApp::builder().test_routes().start().await;
    let song = add_song(&app, "Solo", "Solo", SOLO).await;
    let people = profiles(&app, 4).await;
    store(&app, &song, vec![score(of(&people[0]), 7000)]).await;
    store(&app, &song, vec![score(of(&people[1]), 8000)]).await;
    store(&app, &song, vec![score(of(&people[2]), 8000)]).await;
    store(&app, &song, vec![score(of(&people[3]), 7000)]).await;

    assert_eq!(
        hard_table(&app, &song).await,
        vec![
            (1, "P02".into(), 8000),
            (1, "P03".into(), 8000),
            (3, "P01".into(), 7000),
            (3, "P04".into(), 7000),
        ]
    );
}

#[tokio::test]
async fn the_new_high_score_flag_is_set_only_for_a_counted_record_above_the_previous_best() {
    let app = TestApp::builder().test_routes().start().await;
    let song = add_song(&app, "Solo", "Solo", SOLO).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;

    // First record: Ada's is new, a Guest's never is, a 0 never is.
    let first = store(
        &app,
        &song,
        vec![
            score(of(&ada), 6000),
            score(guest("Gus"), 9000),
            score(of(&bo), 0),
        ],
    )
    .await;
    assert_eq!(flags(&first), vec![true, false, false]);
    // Strictly higher, equal, lower.
    let higher = store(&app, &song, vec![score(of(&ada), 6001)]).await;
    assert_eq!(flags(&higher), vec![true]);
    let equal = store(&app, &song, vec![score(of(&ada), 6001)]).await;
    assert_eq!(flags(&equal), vec![false]);
    let lower = store(&app, &song, vec![score(of(&ada), 5000)]).await;
    assert_eq!(flags(&lower), vec![false]);
    // An unfinished record is never new and does not raise the bar.
    let cut = store(&app, &song, vec![unfinished(score(of(&ada), 9900))]).await;
    assert_eq!(flags(&cut), vec![false]);
    let after_cut = store(&app, &song, vec![score(of(&ada), 7000)]).await;
    assert_eq!(flags(&after_cut), vec![true]);
    // Another Difficulty is another table, so its first record is new.
    let easy = store(
        &app,
        &song,
        vec![at(score(of(&ada), 100), Difficulty::Easy)],
    )
    .await;
    assert_eq!(flags(&easy), vec![true]);
    // A mic lost record counts.
    let lost = store(&app, &song, vec![mic_lost(score(of(&bo), 10))]).await;
    assert_eq!(flags(&lost), vec![true]);

    // The flag is kept with the records.
    let all = openstar_rounds(&app);
    let kept: Vec<bool> = all
        .iter()
        .flat_map(|r| r.records.iter().map(|x| x.new_high_score))
        .collect();
    assert_eq!(
        kept,
        vec![
            true, false, false, true, false, false, false, true, true, true
        ]
    );
}

async fn top(app: &TestApp, title: &str) -> Option<TopHighScore> {
    row(app, title).await.unwrap().top_high_score
}

fn openstar_rounds(app: &TestApp) -> Vec<StoredRound> {
    let conn =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    openstar::scores::rounds(&conn).unwrap()
}

#[tokio::test]
async fn each_song_row_carries_its_top_high_score_at_any_difficulty_and_voice() {
    let app = TestApp::builder().test_routes().start().await;
    let solo = add_song(&app, "Solo", "Solo", SOLO).await;
    let duet = add_song(&app, "Duet", "Duet", DUET).await;
    add_song(&app, "Unsung", "Unsung", SOLO).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    store(&app, &solo, vec![score(of(&ada), 7000)]).await;
    store(
        &app,
        &solo,
        vec![at(score(of(&bo), 7500), Difficulty::Easy)],
    )
    .await;
    store(&app, &solo, vec![score(guest("Gus"), 9999)]).await;
    store(
        &app,
        &duet,
        vec![
            on_voice(score(of(&ada), 4000), 0),
            on_voice(score(of(&bo), 4200), 1),
        ],
    )
    .await;
    store(
        &app,
        &duet,
        vec![unfinished(on_voice(score(of(&ada), 9000), 0))],
    )
    .await;

    assert_eq!(
        top(&app, "Solo").await,
        Some(TopHighScore {
            holder: holder(&bo),
            total: 7500
        })
    );
    assert_eq!(
        top(&app, "Duet").await,
        Some(TopHighScore {
            holder: holder(&bo),
            total: 4200
        })
    );
    assert_eq!(top(&app, "Unsung").await, None);
}

#[tokio::test]
async fn a_timing_edit_keeps_the_table_and_marks_entries_sung_to_the_older_timing() {
    let app = TestApp::builder().test_routes().start().await;
    let old = add_song(&app, "Solo", "Solo", SOLO).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    store(
        &app,
        &old,
        vec![score(of(&ada), 8000), score(of(&bo), 6000)],
    )
    .await;

    // The Timing edit: same identity, other notes.
    let new = add_song(&app, "Solo", "Solo", SOLO_RETIMED).await;
    assert_eq!(new.identity, old.identity);
    assert_ne!(new.note_fingerprint, old.note_fingerprint);
    let kept = high_scores(&app, &new).await;
    let entries = &table(&kept, 0, Difficulty::Hard).entries;
    assert_eq!(
        entries
            .iter()
            .map(|e| (e.holder.name.as_str(), e.total, e.older_timing))
            .collect::<Vec<_>>(),
        vec![("Ada", 8000, true), ("Bo", 6000, true)],
        "the High scores survive, marked"
    );
    assert_eq!(
        row(&app, "Solo")
            .await
            .unwrap()
            .top_high_score
            .unwrap()
            .total,
        8000
    );

    // Bo beats the old best against the new timing; the mark goes.
    let round = store(&app, &new, vec![score(of(&bo), 6500)]).await;
    assert_eq!(flags(&round), vec![true]);
    let after = high_scores(&app, &new).await;
    assert_eq!(
        table(&after, 0, Difficulty::Hard)
            .entries
            .iter()
            .map(|e| (e.holder.name.as_str(), e.total, e.older_timing))
            .collect::<Vec<_>>(),
        vec![("Ada", 8000, true), ("Bo", 6500, false)]
    );
}

#[tokio::test]
async fn records_hide_while_their_song_is_not_in_the_library_and_show_when_it_returns() {
    let app = TestApp::builder().test_routes().start().await;
    let song = add_song(&app, "Solo", "Solo", SOLO).await;
    let other = add_song(&app, "Other", "Other", SOLO).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    store(&app, &song, vec![score(of(&ada), 8000)]).await;
    assert!(hard_table(&app, &other).await.is_empty(), "per identity");

    std::fs::remove_dir_all(app.songs_dir().join("Solo")).unwrap();
    rescan(&app).await;
    assert!(row(&app, "Solo").await.is_none());
    let gone = app
        .http()
        .get(app.url(&format!("/api/songs/{}/high-scores", song.id.0)))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    assert!(rows(&app).await.iter().all(|s| s.top_high_score.is_none()));

    // The same identity returns in another folder.
    let back = add_song(&app, "Returned", "Solo", SOLO).await;
    assert_ne!(back.id, song.id);
    assert_eq!(back.identity, song.identity);
    assert_eq!(hard_table(&app, &back).await, vec![(1, "Ada".into(), 8000)]);
    assert_eq!(
        row(&app, "Solo")
            .await
            .unwrap()
            .top_high_score
            .unwrap()
            .total,
        8000
    );
}

#[tokio::test]
async fn deleting_a_profile_removes_its_entries_from_every_table() {
    let app = TestApp::builder().test_routes().start().await;
    let song = add_song(&app, "Solo", "Solo", SOLO).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    store(
        &app,
        &song,
        vec![score(of(&ada), 8000), score(of(&bo), 6000)],
    )
    .await;

    // No delete endpoint yet (#45); delete the row as it will.
    let conn =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .unwrap();
    conn.execute("DELETE FROM profiles WHERE id = ?1", [ada.id.0])
        .unwrap();

    assert_eq!(hard_table(&app, &song).await, vec![(1, "Bo".into(), 6000)]);
    assert_eq!(
        row(&app, "Solo").await.unwrap().top_high_score,
        Some(TopHighScore {
            holder: holder(&bo),
            total: 6000
        })
    );
}

#[tokio::test]
async fn a_stored_round_sends_a_library_change_notice() {
    use openstar_protocol::{ChangeTopic, ServerMessage};
    let app = TestApp::builder().test_routes().start().await;
    let song = add_song(&app, "Solo", "Solo", SOLO).await;
    let ada = create_profile(&app, "Ada", PaletteKey::Cherry).await;
    let mut ws = app.connect_ws().await;
    assert!(matches!(ws.recv().await, ServerMessage::LiveState { .. }));
    store(&app, &song, vec![score(of(&ada), 8000)]).await;
    assert_eq!(
        ws.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Library]
        }
    );
}
