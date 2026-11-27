//! Stage options: the choices kept for the Stage that change how a Party
//! plays and looks, set in the Stage's Setup › Options with no Admin PIN.
//! One set is kept for the server (there is one Stage), across Parties and
//! restarts, read at `GET /api/stage-options` and replaced at
//! `PUT /api/stage-options`, which tells every browser with
//! [`crate::ChangeTopic::StageOptions`].
//!
//! Every default is today's behaviour. The frontend mirrors the defaults and
//! ranges in `web/src/stageOptions/stageOptions.ts` (`STAGE_OPTIONS`;
//! `web/checks/stageOptions.test.ts` keeps them equal).
//!
//! To add an option: a field here with `#[serde(default = ...)]` (so a set
//! stored before it existed still reads), its default constant, its check in
//! [`StageOptions::is_valid`], and its row in the frontend's Options screen.

use std::fmt;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::profile::Difficulty;

/// Where a Guest, and a Profile created from now on, start.
pub const STARTING_DIFFICULTY_DEFAULT: Difficulty = Difficulty::Medium;
/// The longest resume countdown, in seconds.
pub const RESUME_COUNTDOWN_MAX_SECONDS: u8 = 5;
/// The 3-2-1 countdown after a pause.
pub const RESUME_COUNTDOWN_DEFAULT_SECONDS: u8 = 3;
/// Line rating words ("Perfect!", "Great!", ...) show when a Line ends.
pub const LINE_RATINGS_DEFAULT: bool = true;
/// Confetti on a Perfect! Line, sparkles on a golden Note and the sing
/// screen's motion all show.
pub const EFFECTS_DEFAULT: Effects = Effects::Full;
/// A Song's video shows behind the lanes.
pub const SONG_VIDEO_DEFAULT: bool = true;
/// One step of the preview volume, in percent.
pub const PREVIEW_VOLUME_STEP_PERCENT: u8 = 10;
/// The song browser's preview plays as loud as the Song.
pub const PREVIEW_VOLUME_DEFAULT_PERCENT: u8 = 100;
/// A Song plays its Intro; Skip intro is offered instead.
pub const SKIP_INTROS_DEFAULT: bool = false;
/// Every screen looks as v1 did.
pub const THEME_DEFAULT: Theme = Theme::BubblePop;

/// How every screen looks: the Stage, each Phone and Admin follow the Stage's
/// choice. The frontend maps each theme to its token values
/// (`web/src/theme/themes.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Theme {
    /// Cream and candy colours: v1's look.
    #[default]
    BubblePop,
    /// Deep navy for a dark room, with the same candy colours.
    BubblePopNight,
    /// Solid surfaces and strong edges for a washed-out TV.
    HighContrast,
}

fn starting_difficulty_default() -> Difficulty {
    STARTING_DIFFICULTY_DEFAULT
}
fn resume_countdown_default() -> u8 {
    RESUME_COUNTDOWN_DEFAULT_SECONDS
}
fn line_ratings_default() -> bool {
    LINE_RATINGS_DEFAULT
}
fn effects_default() -> Effects {
    EFFECTS_DEFAULT
}
fn song_video_default() -> bool {
    SONG_VIDEO_DEFAULT
}
fn preview_volume_default() -> u8 {
    PREVIEW_VOLUME_DEFAULT_PERCENT
}
fn skip_intros_default() -> bool {
    SKIP_INTROS_DEFAULT
}
fn theme_default() -> Theme {
    THEME_DEFAULT
}

/// The Stage options: the body of `GET /api/stage-options` and of
/// `PUT /api/stage-options`, both ways. A field left out reads as its
/// default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageOptions {
    /// The Difficulty a Guest starts at when entering the Party, and a
    /// Profile when it is created. A Profile that has sung keeps its last.
    #[serde(default = "starting_difficulty_default")]
    pub starting_difficulty: Difficulty,
    /// The countdown after a pause before the Song plays on, 0 to 5 seconds;
    /// 0 plays on at once.
    #[serde(default = "resume_countdown_default")]
    pub resume_countdown_seconds: u8,
    /// Whether a Line's rating word shows when it ends. The Line bonus is
    /// scored either way.
    #[serde(default = "line_ratings_default")]
    pub line_ratings: bool,
    /// How much the sing screen celebrates: confetti, sparkles and motion.
    #[serde(default = "effects_default")]
    pub effects: Effects,
    /// Whether a Song's video shows behind the lanes; without it, its
    /// background or cover shows.
    #[serde(default = "song_video_default")]
    pub song_video: bool,
    /// How loud the song browser's preview plays, 0 to 100 % of the Song's
    /// level, in 10 % steps.
    #[serde(default = "preview_volume_default")]
    pub preview_volume_percent: u8,
    /// Whether a Song with an Intro starts where Skip intro would land, a
    /// few seconds before its first Note, instead of at `#START`. Restart
    /// starts there too.
    #[serde(default = "skip_intros_default")]
    pub skip_intros: bool,
    /// How every screen looks; Phones follow the Stage's theme. Its range is
    /// its three values: any other is refused.
    #[serde(default = "theme_default")]
    pub theme: Theme,
}

/// How much the sing screen celebrates. Sent as `"off"`, `"calm"` or
/// `"full"`; a set stored when Effects was a switch reads `true` as `full`
/// and `false` as `off`, so it keeps its other options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Effects {
    /// No confetti, no sparkles, and the Stage's motion turns into fades.
    Off,
    /// Golden-Note sparkles only: no confetti and no screen motion.
    Calm,
    /// Confetti on a Perfect! Line, sparkles on a golden Note, and motion.
    Full,
}

impl<'de> Deserialize<'de> for Effects {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EffectsVisitor;

        impl Visitor<'_> for EffectsVisitor {
            type Value = Effects;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str(r#""off", "calm", "full", or a stored true or false"#)
            }

            fn visit_bool<E: de::Error>(self, on: bool) -> Result<Effects, E> {
                Ok(if on { Effects::Full } else { Effects::Off })
            }

            fn visit_str<E: de::Error>(self, name: &str) -> Result<Effects, E> {
                match name {
                    "off" => Ok(Effects::Off),
                    "calm" => Ok(Effects::Calm),
                    "full" => Ok(Effects::Full),
                    other => Err(E::unknown_variant(other, &["off", "calm", "full"])),
                }
            }
        }

        deserializer.deserialize_any(EffectsVisitor)
    }
}

impl Default for StageOptions {
    fn default() -> Self {
        Self {
            starting_difficulty: STARTING_DIFFICULTY_DEFAULT,
            resume_countdown_seconds: RESUME_COUNTDOWN_DEFAULT_SECONDS,
            line_ratings: LINE_RATINGS_DEFAULT,
            effects: EFFECTS_DEFAULT,
            song_video: SONG_VIDEO_DEFAULT,
            preview_volume_percent: PREVIEW_VOLUME_DEFAULT_PERCENT,
            skip_intros: SKIP_INTROS_DEFAULT,
            theme: THEME_DEFAULT,
        }
    }
}

impl StageOptions {
    /// Whether every value is within its range (and on its step).
    pub fn is_valid(&self) -> bool {
        self.resume_countdown_seconds <= RESUME_COUNTDOWN_MAX_SECONDS
            && self.preview_volume_percent <= 100
            && self
                .preview_volume_percent
                .is_multiple_of(PREVIEW_VOLUME_STEP_PERCENT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_valid_and_a_missing_field_reads_as_its_default() {
        assert!(StageOptions::default().is_valid());
        let read: StageOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(read, StageOptions::default());
        let read: StageOptions = serde_json::from_str(r#"{"effects":"calm"}"#).unwrap();
        assert_eq!(
            read,
            StageOptions {
                effects: Effects::Calm,
                ..StageOptions::default()
            }
        );
    }

    #[test]
    fn a_v1_row_reads_with_the_new_options_at_their_defaults() {
        let v1 = r#"{"startingDifficulty":"hard","resumeCountdownSeconds":3,"lineRatings":true,"effects":true,"songVideo":true,"previewVolumePercent":100}"#;
        let read: StageOptions = serde_json::from_str(v1).unwrap();
        assert_eq!(read.theme, Theme::BubblePop);
        assert_eq!(read.starting_difficulty, Difficulty::Hard);
    }

    #[test]
    fn a_theme_is_one_of_three_and_nothing_else_reads() {
        for (json, theme) in [
            ("bubblePop", Theme::BubblePop),
            ("bubblePopNight", Theme::BubblePopNight),
            ("highContrast", Theme::HighContrast),
        ] {
            let read: StageOptions =
                serde_json::from_value(serde_json::json!({ "theme": json })).unwrap();
            assert_eq!(read.theme, theme);
        }
        assert!(
            serde_json::from_value::<StageOptions>(serde_json::json!({ "theme": "pink" })).is_err()
        );
    }

    #[test]
    fn a_stored_true_or_false_reads_as_full_or_off_and_keeps_the_other_options() {
        // A set stored before Effects had three values.
        let v1 = r#"{"startingDifficulty":"easy","resumeCountdownSeconds":0,
            "lineRatings":false,"effects":true,"songVideo":false,
            "previewVolumePercent":40}"#;
        let read: StageOptions = serde_json::from_str(v1).unwrap();
        assert_eq!(read.effects, Effects::Full);
        assert_eq!(read.starting_difficulty, Difficulty::Easy);
        assert_eq!(read.preview_volume_percent, 40);
        let read: StageOptions = serde_json::from_str(r#"{"effects":false}"#).unwrap();
        assert_eq!(read.effects, Effects::Off);
    }

    #[test]
    fn each_effects_value_round_trips_as_its_name() {
        for (effects, name) in [
            (Effects::Off, "off"),
            (Effects::Calm, "calm"),
            (Effects::Full, "full"),
        ] {
            let options = StageOptions {
                effects,
                ..StageOptions::default()
            };
            let json = serde_json::to_value(&options).unwrap();
            assert_eq!(json["effects"], name);
            let read: StageOptions = serde_json::from_value(json).unwrap();
            assert_eq!(read, options);
        }
        assert!(serde_json::from_str::<StageOptions>(r#"{"effects":"loud"}"#).is_err());
        assert!(serde_json::from_str::<StageOptions>(r#"{"effects":1}"#).is_err());
    }

    #[test]
    fn out_of_range_values_are_not_valid() {
        for options in [
            StageOptions {
                resume_countdown_seconds: 6,
                ..StageOptions::default()
            },
            StageOptions {
                preview_volume_percent: 110,
                ..StageOptions::default()
            },
            StageOptions {
                preview_volume_percent: 55,
                ..StageOptions::default()
            },
        ] {
            assert!(!options.is_valid(), "{options:?}");
        }
        assert!(
            StageOptions {
                resume_countdown_seconds: 0,
                preview_volume_percent: 0,
                ..StageOptions::default()
            }
            .is_valid()
        );
    }

    #[test]
    fn it_is_sent_in_camel_case() {
        let json = serde_json::to_value(StageOptions::default()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "startingDifficulty": "medium",
                "resumeCountdownSeconds": 3,
                "lineRatings": true,
                "effects": "full",
                "songVideo": true,
                "previewVolumePercent": 100,
                "skipIntros": false,
                "theme": "bubblePop",
            })
        );
    }
}
