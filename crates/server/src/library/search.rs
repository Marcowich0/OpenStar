//! Search and filters over the listed Songs (`GET /api/songs`).
//!
//! The index hands over every listed Song (playable, each identity once)
//! with its filter fields; the query is applied here, in memory, so text
//! compares with the same Unicode case folding as Song identity. A Library
//! holds hundreds of Songs, so a pass over all of them per request is cheap.

use std::collections::BTreeSet;

use openstar_protocol::library::{LengthRange, SongFilters, SongList, SongQuery, SongSummary};

use super::identity::normalise;

/// A listed Song and the fields the filters look at.
pub(crate) struct Listed {
    pub summary: SongSummary,
    pub year: Option<i32>,
    /// The list headers, each split on commas and trimmed.
    pub languages: Vec<String>,
    pub genres: Vec<String>,
    pub editions: Vec<String>,
    pub creators: Vec<String>,
}

/// The Songs of `listed` that match `query`, in the order given, and the
/// values each filter can take over all of `listed`.
pub(crate) fn apply(listed: Vec<Listed>, query: &SongQuery) -> SongList {
    let filters = filters(&listed);
    let matcher = Matcher::new(query);
    let songs = listed
        .into_iter()
        .filter(|song| matcher.matches(song))
        .map(|song| song.summary)
        .collect();
    SongList { songs, filters }
}

/// A query with its text folded once.
struct Matcher<'q> {
    query: &'q SongQuery,
    words: Vec<String>,
    language: Option<String>,
    genre: Option<String>,
    edition: Option<String>,
    creator: Option<String>,
}

impl<'q> Matcher<'q> {
    fn new(query: &'q SongQuery) -> Self {
        let fold = |value: &Option<String>| value.as_deref().map(normalise);
        Self {
            query,
            words: query
                .search
                .as_deref()
                .map(|s| normalise(s).split(' ').map(str::to_owned).collect())
                .unwrap_or_default(),
            language: fold(&query.language),
            genre: fold(&query.genre),
            edition: fold(&query.edition),
            creator: fold(&query.creator),
        }
    }

    fn matches(&self, song: &Listed) -> bool {
        let summary = &song.summary;
        let query = self.query;
        let length_ok = |bound: Option<f64>, ok: fn(f64, f64) -> bool| match bound {
            None => true,
            Some(bound) => summary.length_seconds.is_some_and(|l| ok(l, bound)),
        };
        self.search_matches(summary)
            && one_of(&self.language, &song.languages)
            && one_of(&self.genre, &song.genres)
            && one_of(&self.edition, &song.editions)
            && one_of(&self.creator, &song.creators)
            && query.year.is_none_or(|year| song.year == Some(year))
            && query.duet.is_none_or(|duet| summary.duet == duet)
            && query
                .has_video
                .is_none_or(|video| summary.has_video == video)
            && length_ok(query.min_length_seconds, |l, min| l >= min)
            && length_ok(query.max_length_seconds, |l, max| l <= max)
    }

    /// Every word appears in the artist or the title.
    fn search_matches(&self, summary: &SongSummary) -> bool {
        if self.words.iter().all(|w| w.is_empty()) {
            return true;
        }
        let artist = normalise(&summary.artist);
        let title = normalise(&summary.title);
        self.words
            .iter()
            .all(|word| artist.contains(word.as_str()) || title.contains(word.as_str()))
    }
}

/// No value asked for, or one of `values` equals it once folded.
fn one_of(wanted: &Option<String>, values: &[String]) -> bool {
    wanted
        .as_ref()
        .is_none_or(|wanted| values.iter().any(|v| normalise(v) == *wanted))
}

fn filters(listed: &[Listed]) -> SongFilters {
    let years: BTreeSet<i32> = listed.iter().filter_map(|s| s.year).collect();
    let flags = |flag: fn(&SongSummary) -> bool| {
        let present: BTreeSet<bool> = listed.iter().map(|s| flag(&s.summary)).collect();
        present.into_iter().collect()
    };
    let lengths = listed.iter().filter_map(|s| s.summary.length_seconds);
    let length = lengths.fold(None, |range: Option<LengthRange>, l| {
        Some(match range {
            None => LengthRange {
                min_seconds: l,
                max_seconds: l,
            },
            Some(r) => LengthRange {
                min_seconds: r.min_seconds.min(l),
                max_seconds: r.max_seconds.max(l),
            },
        })
    });
    SongFilters {
        languages: values(listed, |s| &s.languages),
        genres: values(listed, |s| &s.genres),
        years: years.into_iter().collect(),
        editions: values(listed, |s| &s.editions),
        creators: values(listed, |s| &s.creators),
        duet: flags(|s| s.duet),
        has_video: flags(|s| s.has_video),
        length,
    }
}

/// The distinct values of one list header, compared folded: each listed
/// once as first written, sorted by the folded value.
fn values(listed: &[Listed], field: fn(&Listed) -> &Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeMap::new();
    for value in listed.iter().flat_map(|s| field(s)) {
        let folded = normalise(value);
        if !folded.is_empty() {
            seen.entry(folded).or_insert_with(|| value.clone());
        }
    }
    seen.into_values().collect()
}
