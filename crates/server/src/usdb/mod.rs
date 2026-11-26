//! Talking to USDB. [`UsdbClient`] is the only code that fetches from it
//! (login, pacing, backoff); everything else here is pure: parsers from
//! saved pages to data, and the rewrite of USDB's text into the `song.txt` a
//! Download writes.

mod client;
pub(crate) mod covers;
mod detail;
mod html;
pub(crate) mod http;
mod list;
mod search;
mod login;
pub(crate) mod mirror;
mod song_txt;
mod text;

pub use client::{
    FIRST_BACKOFF, MAX_BACKOFF, MAX_TRIES, PACING, SystemTimer, UsdbClient, UsdbTimer,
    VirtualTimer, backoff_wait,
};
pub use detail::comment_links;
pub use list::{SongListRow, parse_song_list, parse_song_list_total};
pub use login::{Profile, is_not_logged_in, parse_profile};
pub use song_txt::{UsdbCover, rewrite_song_txt};
pub use text::{UsdbPageError, parse_gettxt, video_tag_links};
