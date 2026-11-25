//! Searching and filtering the Library through `GET /api/songs`, on a copy of
//! `fixtures/library-search/` (see its README for what each Song covers).
//! Media files are created empty at test time.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use openstar_protocol::library::{LengthRange, SongFilters, SongList, SongQuery};
use openstar_test_harness::{AppFolders, TestApp};

const SUNNY: &str = "Sunny Day";
const NIGHT: &str = "Night Song";
const STRASSE: &str = "Lange Straße";
const COPIED: &str = "Copied Song";

fn fixture_library() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/library-search")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

async fn start() -> TestApp {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_dir(&fixture_library(), songs);
    let list = std::fs::read_to_string(fixture_library().join("media.list")).unwrap();
    for line in list
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        std::fs::write(songs.join(line), b"").unwrap();
    }
    // `TestApp` returns once the start-up scan has finished.
    TestApp::builder().folders(folders).start().await
}

async fn list(app: &TestApp, query: &SongQuery) -> SongList {
    let response = app
        .http()
        .get(app.url("/api/songs"))
        .query(query)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{query:?}");
    response.json().await.unwrap()
}

/// The titles `query` lists, in the order they come.
async fn titles(app: &TestApp, query: SongQuery) -> Vec<String> {
    list(app, &query)
        .await
        .songs
        .into_iter()
        .map(|s| s.title)
        .collect()
}

fn set(titles: &[&str]) -> BTreeSet<String> {
    titles.iter().map(|t| (*t).to_owned()).collect()
}

async fn matches(app: &TestApp, query: SongQuery) -> BTreeSet<String> {
    titles(app, query).await.into_iter().collect()
}

#[tokio::test]
async fn without_a_query_every_playable_song_is_listed_once() {
    let app = start().await;
    assert_eq!(
        titles(&app, SongQuery::default()).await,
        [SUNNY, NIGHT, COPIED, STRASSE],
        "by artist: Alpha, Beta, Gamma, Ünïcode; the rejected Song is absent \
         and the two copies of one identity are listed once"
    );
}

#[tokio::test]
async fn search_matches_artist_and_title_case_insensitively() {
    let app = start().await;
    let search = |text: &str| SongQuery {
        search: Some(text.into()),
        ..SongQuery::default()
    };
    assert_eq!(matches(&app, search("sunny")).await, set(&[SUNNY]));
    assert_eq!(matches(&app, search("BETA")).await, set(&[NIGHT]));
    assert_eq!(matches(&app, search("song")).await, set(&[NIGHT, COPIED]));
    assert_eq!(
        matches(&app, search("STRASSE ünïCODE")).await,
        set(&[STRASSE]),
        "Unicode case folding, words across artist and title"
    );
    assert_eq!(matches(&app, search("  alpha   day ")).await, set(&[SUNNY]));
    assert_eq!(matches(&app, search("alpha night")).await, set(&[]));
    assert_eq!(matches(&app, search("never")).await, set(&[]), "rejected");
    assert_eq!(matches(&app, search("  ")).await.len(), 4, "no words");
}

#[tokio::test]
async fn list_filters_match_any_of_a_header_s_comma_split_values() {
    let app = start().await;
    let q = SongQuery::default;
    let language = |v: &str| SongQuery {
        language: Some(v.into()),
        ..q()
    };
    assert_eq!(
        matches(&app, language("English")).await,
        set(&[SUNNY, STRASSE, COPIED])
    );
    assert_eq!(matches(&app, language("spanish")).await, set(&[SUNNY]));
    assert_eq!(matches(&app, language("French")).await, set(&[]));
    assert_eq!(
        matches(&app, language("Engl")).await,
        set(&[]),
        "whole values"
    );

    let genre = |v: &str| SongQuery {
        genre: Some(v.into()),
        ..q()
    };
    assert_eq!(
        matches(&app, genre("Rock")).await,
        set(&[SUNNY, NIGHT]),
        "a repeated #GENRE is joined"
    );
    assert_eq!(matches(&app, genre("pop")).await, set(&[SUNNY]));

    let edition = |v: &str| SongQuery {
        edition: Some(v.into()),
        ..q()
    };
    assert_eq!(
        matches(&app, edition("placeholder duets")).await,
        set(&[NIGHT])
    );

    let creator = |v: &str| SongQuery {
        creator: Some(v.into()),
        ..q()
    };
    assert_eq!(matches(&app, creator("alice")).await, set(&[SUNNY, NIGHT]));
    assert_eq!(matches(&app, creator("Bob")).await, set(&[NIGHT]));
}

#[tokio::test]
async fn year_duet_video_and_length_filter() {
    let app = start().await;
    let q = SongQuery::default;
    assert_eq!(
        matches(
            &app,
            SongQuery {
                year: Some(2005),
                ..q()
            }
        )
        .await,
        set(&[NIGHT, STRASSE])
    );
    assert_eq!(
        matches(
            &app,
            SongQuery {
                duet: Some(true),
                ..q()
            }
        )
        .await,
        set(&[NIGHT])
    );
    assert_eq!(
        matches(
            &app,
            SongQuery {
                duet: Some(false),
                ..q()
            }
        )
        .await,
        set(&[SUNNY, STRASSE, COPIED])
    );
    assert_eq!(
        matches(
            &app,
            SongQuery {
                has_video: Some(true),
                ..q()
            }
        )
        .await,
        set(&[NIGHT])
    );
    assert_eq!(
        matches(
            &app,
            SongQuery {
                has_video: Some(false),
                ..q()
            }
        )
        .await,
        set(&[SUNNY, STRASSE, COPIED])
    );
    assert_eq!(
        matches(
            &app,
            SongQuery {
                min_length_seconds: Some(180.0),
                ..q()
            }
        )
        .await,
        set(&[SUNNY, NIGHT]),
        "inclusive; a Song of unknown length never matches"
    );
    assert_eq!(
        matches(
            &app,
            SongQuery {
                min_length_seconds: Some(100.0),
                max_length_seconds: Some(180.0),
                ..q()
            }
        )
        .await,
        set(&[SUNNY, COPIED])
    );
}

#[tokio::test]
async fn filters_and_search_combine() {
    let app = start().await;
    let query = SongQuery {
        search: Some("e".into()),
        language: Some("english".into()),
        year: Some(2005),
        duet: Some(false),
        ..SongQuery::default()
    };
    assert_eq!(matches(&app, query).await, set(&[STRASSE]));
}

#[tokio::test]
async fn the_list_names_the_values_each_filter_can_take() {
    let app = start().await;
    let expected = SongFilters {
        languages: vec!["English".into(), "German".into(), "Spanish".into()],
        genres: vec!["Jazz".into(), "Pop".into(), "Rock".into()],
        years: vec![1999, 2005, 2010],
        editions: vec!["Placeholder Duets".into(), "Placeholder Hits".into()],
        creators: vec!["alice".into(), "bob".into(), "carol".into()],
        duet: vec![false, true],
        has_video: vec![false, true],
        length: Some(LengthRange {
            min_seconds: 120.0,
            max_seconds: 240.0,
        }),
    };
    assert_eq!(list(&app, &SongQuery::default()).await.filters, expected);
    let narrow = SongQuery {
        search: Some("sunny".into()),
        ..SongQuery::default()
    };
    assert_eq!(
        list(&app, &narrow).await.filters,
        expected,
        "the values of the whole Library, whatever the query"
    );
}

#[tokio::test]
async fn a_value_that_does_not_parse_is_refused() {
    let app = start().await;
    for query in ["year=soon", "duet=maybe", "minLengthSeconds=long"] {
        let response = app
            .http()
            .get(app.url(&format!("/api/songs?{query}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "{query}");
    }
}
