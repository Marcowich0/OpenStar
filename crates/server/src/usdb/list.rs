//! The song list page (`POST ?link=list`).

use std::sync::LazyLock;

use regex::Regex;

use super::html::cell_text;

/// One row of USDB's song list: the fields the mirror keeps.
#[derive(Debug, Clone, PartialEq)]
pub struct SongListRow {
    /// The USDB id.
    pub id: u32,
    pub artist: String,
    pub title: String,
    /// Empty when USDB has none.
    pub genre: String,
    /// `None` when USDB's year is not a four-digit number.
    pub year: Option<u16>,
    /// Empty when USDB has none.
    pub edition: String,
    /// Whether the text has Golden Notes.
    pub golden: bool,
    /// As USDB lists it, for example `English, German`.
    pub language: String,
    pub creator: String,
    /// Stars, 0 to 5 in steps of 0.5.
    pub rating: f32,
    pub views: u32,
    /// USDB's last change of the song, in Unix seconds.
    pub last_change: i64,
}

/// One row: `data-songid` and `data-lastchange` on the `<tr>`, then the
/// sample and cover cells, then one `<td>` per field. Shape as usdb_syncer
/// (`bohning/usdb_syncer` @ `1a4b048`, `SONG_LIST_ROW_REGEX`) reads it.
static ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?s)<tr class="list_tr\d"\s+data-songid="(?P<id>\d+)"\s+"#,
        r#"data-lastchange="(?P<lastchange>\d+)"[^>]*>\s*"#,
        r"<td[^>]*>.*?</td>\s*",
        r"<td[^>]*>.*?</td>\s*",
        r"<td[^>]*>(?P<artist>.*?)</td>\s*",
        r"<td[^>]*>(?P<title>.*?)</td>\s*",
        r"<td[^>]*>(?P<genre>.*?)</td>\s*",
        r"<td[^>]*>(?P<year>.*?)</td>\s*",
        r"<td[^>]*>(?P<edition>.*?)</td>\s*",
        r"<td[^>]*>(?P<golden>.*?)</td>\s*",
        r"<td[^>]*>(?P<language>.*?)</td>\s*",
        r"<td[^>]*>(?P<creator>.*?)</td>\s*",
        r"<td[^>]*>(?P<rating>.*?)</td>\s*",
        r"<td[^>]*>(?P<views>.*?)</td>",
    ))
    .expect("valid regex")
});

/// Every row of a song list page, in page order. A row that does not have
/// USDB's shape is skipped; a page with no rows gives an empty list.
pub fn parse_song_list(html: &str) -> Vec<SongListRow> {
    ROW.captures_iter(html)
        .filter_map(|row| {
            let year = cell_text(&row["year"]);
            Some(SongListRow {
                id: row["id"].parse().ok()?,
                artist: cell_text(&row["artist"]),
                title: cell_text(&row["title"]),
                genre: cell_text(&row["genre"]),
                year: (year.len() == 4).then(|| year.parse().ok()).flatten(),
                edition: cell_text(&row["edition"]),
                golden: is_yes(&cell_text(&row["golden"])),
                language: cell_text(&row["language"]),
                creator: cell_text(&row["creator"]),
                rating: stars(&row["rating"]),
                views: cell_text(&row["views"]).parse().unwrap_or(0),
                last_change: row["lastchange"].parse().ok()?,
            })
        })
        .collect()
}

/// "Yes" in each language USDB's pages come in.
fn is_yes(text: &str) -> bool {
    matches!(text, "Yes" | "Ja" | "Oui")
}

/// A full star is `images/star.png`, a half star `images/half_star.png`
/// and an empty one `images/star2.png`.
fn stars(cell: &str) -> f32 {
    let full = cell.matches("/star.png").count();
    let half = cell.matches("/half_star.png").count();
    #[expect(clippy::cast_precision_loss, reason = "at most 5 stars")]
    let rating = full as f32 + 0.5 * half as f32;
    rating
}
