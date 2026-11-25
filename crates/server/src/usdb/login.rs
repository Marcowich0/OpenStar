//! Telling whether a page was served with a login.

use std::sync::LazyLock;

use regex::Regex;

use super::html::cell_text;

/// The sentence USDB shows in place of a page that needs the login.
pub const NOT_LOGGED_IN: &str = "You are not logged in. Login to use this function.";

/// Whether the profile page (`GET ?link=profil`) shows a login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Profile {
    /// The page greets a user by name.
    LoggedIn { user: String },
    /// The page asks for a login.
    LoggedOut,
}

static FORM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<form\b.*?</form\s*>").expect("valid regex"));

/// The greeting at the top of every page when logged in:
/// `<span class='gen'>Welcome <b>name</b>, …` (`Willkommen`, `Bienvenue`
/// in USDB's other languages). Logged out it reads `Welcome, Please login`.
static WELCOME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<span class=['"]gen['"]>\s*[^<\s,]+ <b>(?P<user>[^<]+)</b>"#)
        .expect("valid regex")
});

/// Whether `html` is the page USDB serves instead of a page that needs the
/// login. The sentence counts only outside a `<form>`: a detail page read
/// without a login shows it inside its comment form, and that page is still
/// the detail page.
pub fn is_not_logged_in(html: &str) -> bool {
    FORM.replace_all(html, "").contains(NOT_LOGGED_IN)
}

/// Reads the profile page: logged in when the page greets a user by name.
pub fn parse_profile(html: &str) -> Profile {
    match WELCOME.captures(html) {
        Some(welcome) => Profile::LoggedIn {
            user: cell_text(&welcome["user"]),
        },
        None => Profile::LoggedOut,
    }
}
