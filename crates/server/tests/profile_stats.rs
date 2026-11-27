//! Profile stats through the real app over HTTP
//! (`GET /api/profiles/{id}/stats`): the numbers from known rounds, a
//! Guest's rounds left out, the High scores held matching the Songs' High
//! score tables, a Song that has left the Library, and an unknown Profile.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar_protocol::library::{ScanStatus, SongDetail, SongList};
use openstar_protocol::party::{PartyId, RequestId};
use openstar_protocol::profile::{
    Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile, ProfileStats,
};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, MicKind, PlayerScore, RoundEnd, RoundMode, RoundOutcome, ScorePlayer,
    SongHighScores, StoredRound,
};
use openstar_test_harness::TestApp;
use reqwest::StatusCode;

/// A solo Song of two Notes: Beats 0 to 7.
const SOLO: &str = ": 0 4 0 La\n: 4 4 2 lo\nE\n";
/// A duet: Voice 0 sings Beats 0 to 3, Voice 1 Beats 4 to 7.
const DUET: &str = "P1\n: 0 4 0 La\nP2\n: 4 4 2 lo\nE\n";

fn next_request() -> RequestId {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    RequestId(NEXT.fetch_add(1, Ordering::Relaxed))
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

async fn add_song(app: &TestApp, folder: &str, title: &str, body: &str) -> SongDetail {
    let dir = app.songs_dir().join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    openstar_test_harness::placeholder_media(&dir.join("song.mp3")).unwrap();
    std::fs::write(
        dir.join("song.txt"),
        format!("#ARTIST:Placeholder Artist\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{body}"),
    )
    .unwrap();
    rescan(app).await;
    let list: SongList = app.get_json("/api/songs").await;
    let id = list
        .songs
        .iter()
        .find(|s| s.title == title)
        .unwrap_or_else(|| panic!("{title} is not in the Song list"))
        .id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
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

fn of(profile: &Profile) -> ScorePlayer {
    ScorePlayer::Profile {
        profile_id: profile.id,
    }
}

fn guest(name: &str) -> ScorePlayer {
    ScorePlayer::Guest { name: name.into() }
}

/// A Finished Score at `difficulty` on Voice 0 of a solo Song (Beats 0 to 7).
fn score(player: ScorePlayer, difficulty: Difficulty, total: u32) -> PlayerScore {
    PlayerScore {
        player,
        voice: 0,
        difficulty,
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

/// `score` moved to Voice `voice` of the duet.
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

fn unfinished(mut score: PlayerScore) -> PlayerScore {
    score.unfinished = true;
    score
}

/// Stores a played round of `song`, then moves the clock on a minute.
async fn store(
    app: &TestApp,
    clock: &ManualClock,
    song: &SongDetail,
    scores: Vec<PlayerScore>,
) -> StoredRound {
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
    clock.advance(Duration::from_secs(60));
    serde_json::from_value(json).unwrap()
}

/// When `round` was stored.
fn when(round: &StoredRound) -> i64 {
    round.records[0].recorded_at_ms
}

async fn stats(app: &TestApp, profile: &Profile) -> ProfileStats {
    app.get_json(&format!("/api/profiles/{}/stats", profile.id.0))
        .await
}

#[tokio::test]
async fn known_rounds_over_two_difficulties_give_the_expected_stats_without_guests() {
    let clock = ManualClock::new();
    let app = TestApp::builder().test_routes().clock(&clock).start().await;
    let alpha = add_song(&app, "Alpha", "Alpha", SOLO).await;
    let beta = add_song(&app, "Beta", "Beta", DUET).await;
    let ann = create_profile(&app, "Ann", PaletteKey::Cherry).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;

    // The Guest outscores everyone on Alpha Easy, yet never counts.
    let first = store(
        &app,
        &clock,
        &alpha,
        vec![
            score(of(&ann), Difficulty::Easy, 5000),
            score(guest("Gus"), Difficulty::Easy, 9000),
        ],
    )
    .await;
    let ann_easy_best = store(
        &app,
        &clock,
        &alpha,
        vec![
            score(of(&ann), Difficulty::Easy, 6000),
            score(of(&bo), Difficulty::Easy, 7000),
        ],
    )
    .await;
    let ann_hard_best = store(
        &app,
        &clock,
        &beta,
        vec![
            on_voice(score(of(&ann), Difficulty::Hard, 8000), 1),
            on_voice(score(of(&bo), Difficulty::Hard, 3000), 0),
        ],
    )
    .await;
    // Unfinished: a round, but never a best Score or a High score.
    store(
        &app,
        &clock,
        &beta,
        vec![unfinished(on_voice(
            score(of(&ann), Difficulty::Hard, 9500),
            0,
        ))],
    )
    .await;
    // A Guest's round alone is none of Ann's.
    store(
        &app,
        &clock,
        &alpha,
        vec![score(guest("Gus"), Difficulty::Medium, 9999)],
    )
    .await;
    let last = store(
        &app,
        &clock,
        &alpha,
        vec![unfinished(score(of(&ann), Difficulty::Medium, 100))],
    )
    .await;

    let stats = stats(&app, &ann).await;
    let json = serde_json::to_value(&stats).unwrap();

    assert_eq!(json["songsSung"], 2);
    assert_eq!(json["rounds"], 5);
    assert_eq!(json["finishedRounds"], 3);

    let best: Vec<_> = stats
        .best_per_difficulty
        .iter()
        .map(|b| (b.difficulty, b.total, b.song.title.as_str(), b.recorded_at))
        .collect();
    assert_eq!(
        best,
        vec![
            (Difficulty::Easy, 6000, "Alpha", when(&ann_easy_best)),
            (Difficulty::Hard, 8000, "Beta", when(&ann_hard_best)),
        ]
    );

    let held: Vec<_> = stats
        .high_scores_held
        .iter()
        .map(|h| (h.song.id, h.voice, h.difficulty, h.total))
        .collect();
    assert_eq!(held, vec![(Some(beta.id), 1, Difficulty::Hard, 8000)]);

    let most: Vec<_> = stats
        .most_sung
        .iter()
        .map(|m| (m.song.id, m.song.title.as_str(), m.rounds))
        .collect();
    assert_eq!(
        most,
        vec![(Some(alpha.id), "Alpha", 3), (Some(beta.id), "Beta", 2)]
    );
    assert_eq!(stats.most_sung[0].song.artist, "Placeholder Artist");

    let first_sung = stats.first_sung.as_ref().unwrap();
    assert_eq!(
        (first_sung.song.id, first_sung.at),
        (Some(alpha.id), when(&first))
    );
    let last_sung = stats.last_sung.as_ref().unwrap();
    assert_eq!(
        (last_sung.song.id, last_sung.at),
        (Some(alpha.id), when(&last))
    );

    // Bo: two rounds, both Finished, and the High score of Alpha Easy.
    let bo_stats = self::stats(&app, &bo).await;
    assert_eq!(
        (
            bo_stats.songs_sung,
            bo_stats.rounds,
            bo_stats.finished_rounds
        ),
        (2, 2, 2)
    );
    let bo_held: Vec<_> = bo_stats
        .high_scores_held
        .iter()
        .map(|h| (h.song.id, h.voice, h.difficulty, h.total))
        .collect();
    assert_eq!(
        bo_held,
        vec![
            (Some(alpha.id), 0, Difficulty::Easy, 7000),
            (Some(beta.id), 0, Difficulty::Hard, 3000),
        ]
    );
}

/// Every (Song, Voice, Difficulty, total) whose High score table `profile`
/// heads, read from `GET /api/songs/{id}/high-scores`.
async fn heads(
    app: &TestApp,
    songs: &[&SongDetail],
    profile: &Profile,
) -> Vec<(u32, u32, &'static str, u32)> {
    let mut heads = Vec::new();
    for song in songs {
        let tables: SongHighScores = app
            .get_json(&format!("/api/songs/{}/high-scores", song.id.0))
            .await;
        for table in tables.tables {
            if let Some(entry) = table
                .entries
                .iter()
                .find(|e| e.place == 1 && e.holder.profile_id == profile.id)
            {
                heads.push((
                    song.id.0,
                    table.voice,
                    table.difficulty.as_str(),
                    entry.total,
                ));
            }
        }
    }
    heads.sort_unstable();
    heads
}

#[tokio::test]
async fn the_high_scores_held_match_the_songs_high_score_tables() {
    let clock = ManualClock::new();
    let app = TestApp::builder().test_routes().clock(&clock).start().await;
    let alpha = add_song(&app, "Alpha", "Alpha", SOLO).await;
    let beta = add_song(&app, "Beta", "Beta", DUET).await;
    let ann = create_profile(&app, "Ann", PaletteKey::Cherry).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;

    for (song, scores) in [
        (
            &alpha,
            vec![
                score(of(&ann), Difficulty::Easy, 4000),
                score(of(&bo), Difficulty::Easy, 4000),
            ],
        ),
        (
            &alpha,
            vec![
                score(of(&ann), Difficulty::Medium, 5000),
                score(of(&bo), Difficulty::Hard, 6000),
            ],
        ),
        (
            &alpha,
            vec![
                score(of(&ann), Difficulty::Hard, 5500),
                score(guest("Gus"), Difficulty::Medium, 9000),
            ],
        ),
        (
            &beta,
            vec![
                on_voice(score(of(&ann), Difficulty::Medium, 7000), 0),
                on_voice(score(of(&bo), Difficulty::Medium, 7100), 1),
            ],
        ),
        (
            &beta,
            vec![on_voice(score(of(&bo), Difficulty::Medium, 7200), 0)],
        ),
    ] {
        store(&app, &clock, song, scores).await;
    }

    for profile in [&ann, &bo] {
        let mut held: Vec<_> = stats(&app, profile)
            .await
            .high_scores_held
            .iter()
            .map(|h| {
                (
                    h.song.id.unwrap().0,
                    h.voice,
                    h.difficulty.as_str(),
                    h.total,
                )
            })
            .collect();
        held.sort_unstable();
        assert!(!held.is_empty(), "{} holds a High score", profile.name);
        assert_eq!(
            held,
            heads(&app, &[&alpha, &beta], profile).await,
            "{}",
            profile.name
        );
    }
}

#[tokio::test]
async fn a_song_that_left_the_library_still_counts_by_its_stored_title_and_artist() {
    let clock = ManualClock::new();
    let app = TestApp::builder().test_routes().clock(&clock).start().await;
    let alpha = add_song(&app, "Alpha", "Alpha", SOLO).await;
    let ann = create_profile(&app, "Ann", PaletteKey::Cherry).await;
    store(
        &app,
        &clock,
        &alpha,
        vec![score(of(&ann), Difficulty::Hard, 6000)],
    )
    .await;
    let in_library = stats(&app, &ann).await;
    assert_eq!(in_library.most_sung[0].song.id, Some(alpha.id));

    std::fs::remove_dir_all(app.songs_dir().join("Alpha")).unwrap();
    rescan(&app).await;

    let stats = stats(&app, &ann).await;
    assert_eq!((stats.songs_sung, stats.rounds), (1, 1));
    let gone = &stats.most_sung[0].song;
    assert_eq!(gone.id, None);
    assert_eq!(gone.cover, None);
    assert_eq!(
        (gone.artist.as_str(), gone.title.as_str()),
        ("Placeholder Artist", "Alpha")
    );
    assert_eq!(gone.tile_colour, in_library.most_sung[0].song.tile_colour);
    assert_eq!(stats.best_per_difficulty[0].song, *gone);
    assert_eq!(stats.high_scores_held[0].song, *gone);
    assert_eq!(stats.last_sung.unwrap().song, *gone);
}

#[tokio::test]
async fn a_profile_that_never_sang_has_empty_stats() {
    let app = TestApp::builder().test_routes().start().await;
    let ann = create_profile(&app, "Ann", PaletteKey::Cherry).await;
    let json: serde_json::Value = app
        .get_json(&format!("/api/profiles/{}/stats", ann.id.0))
        .await;
    assert_eq!(
        json,
        serde_json::json!({
            "songsSung": 0,
            "rounds": 0,
            "finishedRounds": 0,
            "bestPerDifficulty": [],
            "highScoresHeld": [],
            "mostSung": [],
            "firstSung": null,
            "lastSung": null,
        })
    );
}

#[tokio::test]
async fn an_unknown_profile_has_no_stats() {
    let app = TestApp::start().await;
    let response = app
        .http()
        .get(app.url("/api/profiles/999/stats"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body, serde_json::json!({ "code": "profileNotFound" }));
}
