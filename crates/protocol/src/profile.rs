//! Profiles over HTTP+JSON, and the palette and avatar keys every colour and
//! avatar is stored as.
//!
//! - `GET /api/profiles`: every [`Profile`], in "Who's singing?" order: by
//!   last sung, most recent first, then the never-sung ones by name.
//! - `GET /api/profiles/{id}`: one [`Profile`], or `404`
//!   [`UserMessage::ProfileNotFound`].
//! - `POST /api/profiles` with a [`NewProfile`]: creates a Profile and answers
//!   `201` with it.
//! - `PATCH /api/profiles/{id}` with a [`ProfileEdit`]: changes any of the
//!   name, avatar and favourite colour of any Profile and answers with it.
//! - `GET /api/profiles/{id}/stats`: the Profile's [`ProfileStats`], or `404`
//!   [`UserMessage::ProfileNotFound`].
//!
//! Anyone may call them: no Unlock, no ownership. Deleting a Profile is in the
//! Admin area only: `DELETE /api/profiles/{id}` is guarded and answers `204`,
//! `404` [`UserMessage::ProfileNotFound`] or `409` `profileSinging` while the
//! Profile sings in the playing Song. A refused name answers `422` with
//! [`UserMessage::ProfileNameEmpty`] or [`UserMessage::ProfileNameTooLong`],
//! and a name another Profile holds answers `409` with
//! [`UserMessage::ProfileNameTaken`], which names that Profile. Every create
//! and edit sends [`ChangeTopic::Profiles`] over the WebSocket.
//!
//! [`UserMessage::ProfileNotFound`]: crate::UserMessage::ProfileNotFound
//! [`UserMessage::ProfileNameEmpty`]: crate::UserMessage::ProfileNameEmpty
//! [`UserMessage::ProfileNameTooLong`]: crate::UserMessage::ProfileNameTooLong
//! [`UserMessage::ProfileNameTaken`]: crate::UserMessage::ProfileNameTaken
//! [`ChangeTopic::Profiles`]: crate::ChangeTopic::Profiles

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::library::SongId;

/// The longest Profile (and Guest) name, in characters, after trimming
/// surrounding spaces.
pub const NAME_MAX_LENGTH: u32 = 16;

/// One of the twelve palette colours, by key. Colours are stored and sent as
/// these keys everywhere, never as hex values; a theme maps each key to its
/// own value. [`PaletteKey::ALL`] is the palette order, most distinct first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PaletteKey {
    Cherry,
    Sky,
    Navy,
    Cocoa,
    Teal,
    Lime,
    Berry,
    Mint,
    Bubblegum,
    Forest,
    Grape,
    Tangerine,
}

impl PaletteKey {
    /// The palette, in palette order: "first free colour" means first in this list.
    pub const ALL: [Self; 12] = [
        Self::Cherry,
        Self::Sky,
        Self::Navy,
        Self::Cocoa,
        Self::Teal,
        Self::Lime,
        Self::Berry,
        Self::Mint,
        Self::Bubblegum,
        Self::Forest,
        Self::Grape,
        Self::Tangerine,
    ];

    /// The key as stored and sent, for example `"cherry"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cherry => "cherry",
            Self::Sky => "sky",
            Self::Navy => "navy",
            Self::Cocoa => "cocoa",
            Self::Teal => "teal",
            Self::Lime => "lime",
            Self::Berry => "berry",
            Self::Mint => "mint",
            Self::Bubblegum => "bubblegum",
            Self::Forest => "forest",
            Self::Grape => "grape",
            Self::Tangerine => "tangerine",
        }
    }

    /// The palette colour with this key, if there is one.
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|colour| colour.as_str() == key)
    }
}

/// One of the 24 built-in avatar icons, by key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AvatarKey {
    Star,
    Heart,
    Moon,
    Bolt,
    Note,
    Crown,
    Drop,
    Leaf,
    Diamond,
    Cloud,
    Flame,
    Ghost,
    Sun,
    Planet,
    Rocket,
    Cat,
    Fish,
    Flower,
    Mushroom,
    Apple,
    Guitar,
    Headphones,
    Rainbow,
    Butterfly,
}

impl AvatarKey {
    /// The built-in set, in the order a picker shows it.
    pub const ALL: [Self; 24] = [
        Self::Star,
        Self::Heart,
        Self::Moon,
        Self::Bolt,
        Self::Note,
        Self::Crown,
        Self::Drop,
        Self::Leaf,
        Self::Diamond,
        Self::Cloud,
        Self::Flame,
        Self::Ghost,
        Self::Sun,
        Self::Planet,
        Self::Rocket,
        Self::Cat,
        Self::Fish,
        Self::Flower,
        Self::Mushroom,
        Self::Apple,
        Self::Guitar,
        Self::Headphones,
        Self::Rainbow,
        Self::Butterfly,
    ];

    /// The key as stored and sent, for example `"star"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Star => "star",
            Self::Heart => "heart",
            Self::Moon => "moon",
            Self::Bolt => "bolt",
            Self::Note => "note",
            Self::Crown => "crown",
            Self::Drop => "drop",
            Self::Leaf => "leaf",
            Self::Diamond => "diamond",
            Self::Cloud => "cloud",
            Self::Flame => "flame",
            Self::Ghost => "ghost",
            Self::Sun => "sun",
            Self::Planet => "planet",
            Self::Rocket => "rocket",
            Self::Cat => "cat",
            Self::Fish => "fish",
            Self::Flower => "flower",
            Self::Mushroom => "mushroom",
            Self::Apple => "apple",
            Self::Guitar => "guitar",
            Self::Headphones => "headphones",
            Self::Rainbow => "rainbow",
            Self::Butterfly => "butterfly",
        }
    }

    /// The built-in avatar with this key, if there is one.
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|avatar| avatar.as_str() == key)
    }
}

/// What a Profile's (or Guest's) avatar is. v1 has only the built-in set; an
/// uploaded image becomes another variant (for example `uploaded { id }`)
/// without changing the stored built-in avatars.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Avatar {
    /// One of the built-in icons.
    BuiltIn { key: AvatarKey },
}

/// How strictly a Player's singing is scored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Difficulty {
    Easy,
    /// The default starting Difficulty (`stage_options`): where a Guest, and
    /// a new Profile, start until the Stage options say otherwise.
    #[default]
    Medium,
    Hard,
}

impl Difficulty {
    /// The key as stored and sent, for example `"medium"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Easy => "easy",
            Self::Medium => "medium",
            Self::Hard => "hard",
        }
    }

    /// The Difficulty with this key, if there is one.
    pub fn from_key(key: &str) -> Option<Self> {
        [Self::Easy, Self::Medium, Self::Hard]
            .into_iter()
            .find(|difficulty| difficulty.as_str() == key)
    }
}

/// Names one Profile. Score records are keyed by it, so a rename carries them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProfileId(pub u32);

/// A Profile: a regular's kept identity, editable by anyone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Profile {
    pub id: ProfileId,
    /// Trimmed, at most [`NAME_MAX_LENGTH`] characters, unique ignoring case
    /// and surrounding spaces.
    pub name: String,
    pub avatar: Avatar,
    /// Shown outside a Party, and given in a Party when it is free.
    pub favourite_colour: PaletteKey,
    /// Preselected in the Profile's next seat; until it sings, the Stage
    /// options' starting Difficulty when it was created.
    pub last_difficulty: Difficulty,
    /// When the Profile was created, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub created_at: i64,
    /// When a Score record was last stored for it, in milliseconds since the
    /// Unix epoch; `null` until it sings.
    #[ts(type = "number | null")]
    pub last_sung_at: Option<i64>,
}

/// Body of `POST /api/profiles`, and of joining as a new Profile.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewProfile {
    /// Surrounding spaces are trimmed before the name is checked and stored.
    pub name: String,
    pub avatar: Avatar,
    pub favourite_colour: PaletteKey,
}

/// Body of `PATCH /api/profiles/{id}`: the fields to change; a missing field
/// stays as it is. A new name follows the same rules as on create.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileEdit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar: Option<Avatar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub favourite_colour: Option<PaletteKey>,
}

/// What a Profile has sung, from its Score records (`GET
/// /api/profiles/{id}/stats`). A Guest's Score records never count, and a
/// Song that has left the Library still counts, named as it was last sung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileStats {
    /// How many different Songs (by Song identity) it has a Score record of.
    pub songs_sung: u32,
    /// How many rounds it sang in: one Score record each.
    pub rounds: u32,
    /// How many of those rounds its Score is Finished in.
    pub finished_rounds: u32,
    /// Its best Score at each Difficulty, in the order Easy, Medium, Hard:
    /// only a Score that can be a High score counts (Finished, above 0, a
    /// normal round), the earliest of equal totals, and a Difficulty without
    /// one is left out.
    pub best_per_difficulty: Vec<BestScore>,
    /// The High scores it holds: every Song, Voice and Difficulty whose High
    /// score table it heads (place 1, shared on equal totals), highest total
    /// first, then the earliest set.
    pub high_scores_held: Vec<HeldHighScore>,
    /// At most five Songs, most rounds first, then the most recently sung.
    pub most_sung: Vec<MostSungSong>,
    /// Its first Score record; `null` until it sings.
    pub first_sung: Option<SungAt>,
    /// Its latest Score record; `null` until it sings.
    pub last_sung: Option<SungAt>,
}

/// A Song as Profile stats name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatsSong {
    /// The Song in the Library now; `null` once it has left the Library.
    pub id: Option<SongId>,
    /// The Library's artist while the Song is in it, else the one stored
    /// when it was last sung.
    pub artist: String,
    /// The Library's title while the Song is in it, else the one stored
    /// when it was last sung.
    pub title: String,
    /// The cover image's URL; `null` without one or once the Song left the
    /// Library (show the generated tile).
    pub cover: Option<String>,
    /// The generated tile's colour, from the Song's identity.
    pub tile_colour: PaletteKey,
}

/// A Profile's best Score at one Difficulty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BestScore {
    pub difficulty: Difficulty,
    pub total: u32,
    pub song: StatsSong,
    /// When the Score record was stored, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub recorded_at: i64,
}

/// A High score table a Profile heads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeldHighScore {
    pub song: StatsSong,
    /// The Voice (0 = `P1`).
    pub voice: u32,
    pub difficulty: Difficulty,
    pub total: u32,
}

/// One of a Profile's most-sung Songs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MostSungSong {
    pub song: StatsSong,
    /// How many rounds the Profile sang it in.
    pub rounds: u32,
}

/// When a Profile sang which Song.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SungAt {
    pub song: StatsSong,
    /// When the Score record was stored, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn the_palette_is_the_twelve_keys_in_palette_order() {
        assert_eq!(
            wire(&PaletteKey::ALL),
            r#"["cherry","sky","navy","cocoa","teal","lime","berry","mint","bubblegum","forest","grape","tangerine"]"#
        );
        for colour in PaletteKey::ALL {
            assert_eq!(wire(&colour), format!("\"{}\"", colour.as_str()));
            assert_eq!(PaletteKey::from_key(colour.as_str()), Some(colour));
        }
        assert_eq!(PaletteKey::from_key("#FF4B5C"), None);
    }

    #[test]
    fn the_avatar_set_is_the_24_built_in_keys() {
        assert_eq!(
            wire(&AvatarKey::ALL),
            r#"["star","heart","moon","bolt","note","crown","drop","leaf","diamond","cloud","flame","ghost","sun","planet","rocket","cat","fish","flower","mushroom","apple","guitar","headphones","rainbow","butterfly"]"#
        );
        for avatar in AvatarKey::ALL {
            assert_eq!(wire(&avatar), format!("\"{}\"", avatar.as_str()));
            assert_eq!(AvatarKey::from_key(avatar.as_str()), Some(avatar));
        }
    }

    #[test]
    fn an_avatar_is_tagged_by_kind_so_uploads_can_follow() {
        let avatar = Avatar::BuiltIn {
            key: AvatarKey::Ghost,
        };
        assert_eq!(wire(&avatar), r#"{"kind":"builtIn","key":"ghost"}"#);
        assert_eq!(
            serde_json::from_str::<Avatar>(r#"{"kind":"builtIn","key":"ghost"}"#).unwrap(),
            avatar
        );
    }

    #[test]
    fn a_profile_is_sent_with_keys_and_camel_case_fields() {
        let profile = Profile {
            id: ProfileId(7),
            name: "Bo".into(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::Sky,
            last_difficulty: Difficulty::Medium,
            created_at: 1_000,
            last_sung_at: None,
        };
        assert_eq!(
            wire(&profile),
            r#"{"id":7,"name":"Bo","avatar":{"kind":"builtIn","key":"star"},"favouriteColour":"sky","lastDifficulty":"medium","createdAt":1000,"lastSungAt":null}"#
        );
    }

    #[test]
    fn a_taken_name_names_the_profile_that_holds_it() {
        assert_eq!(
            wire(&crate::UserMessage::ProfileNameTaken {
                profile_id: ProfileId(3)
            }),
            r#"{"code":"profileNameTaken","params":{"profileId":3}}"#
        );
        assert_eq!(wire(&crate::ChangeTopic::Profiles), r#""profiles""#);
    }

    #[test]
    fn an_edit_may_leave_out_any_field() {
        assert_eq!(
            serde_json::from_str::<ProfileEdit>(r#"{"favouriteColour":"lime"}"#).unwrap(),
            ProfileEdit {
                favourite_colour: Some(PaletteKey::Lime),
                ..ProfileEdit::default()
            }
        );
    }

    #[test]
    fn difficulty_keys_round_trip_and_default_to_medium() {
        assert_eq!(Difficulty::default(), Difficulty::Medium);
        for difficulty in [Difficulty::Easy, Difficulty::Medium, Difficulty::Hard] {
            assert_eq!(wire(&difficulty), format!("\"{}\"", difficulty.as_str()));
            assert_eq!(Difficulty::from_key(difficulty.as_str()), Some(difficulty));
        }
    }
}
