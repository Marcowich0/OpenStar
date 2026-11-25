//! The pure, network-free half of talking to USDB: parsers from saved pages
//! to data, and the rewrite of USDB's text into the `song.txt` a Download
//! writes. Nothing here fetches anything.

mod detail;
mod html;
mod list;
mod login;
mod song_txt;
mod text;

pub use detail::comment_links;
pub use list::{SongListRow, parse_song_list};
pub use login::{Profile, is_not_logged_in, parse_profile};
pub use song_txt::{UsdbCover, rewrite_song_txt};
pub use text::{UsdbPageError, parse_gettxt, video_tag_links};
