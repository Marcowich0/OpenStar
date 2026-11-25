//! Small helpers for reading USDB's HTML. USDB's pages are old, loosely
//! formed HTML, so the parsers read them with regular expressions, the way
//! other USDB clients do.

use std::sync::LazyLock;

use regex::Regex;

static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").expect("valid regex"));

/// Decodes HTML entities exactly once: `&amp;amp;` becomes `&amp;`.
pub fn decode_entities(text: &str) -> String {
    html_escape::decode_html_entities(text).into_owned()
}

/// The text of an HTML fragment: tags removed, entities decoded once,
/// surrounding whitespace trimmed.
pub fn cell_text(fragment: &str) -> String {
    decode_entities(&TAG.replace_all(fragment, ""))
        .trim()
        .to_owned()
}
