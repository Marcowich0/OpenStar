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
//! A Phone changes them over the WebSocket with a [`StageOptionsChange`]:
//! only the options it changed, merged onto the kept set, so two devices
//! changing different options keep both. The Party change it makes names
//! the changed ones as [`StageOptionKey`]s.
//!
//! To add an option: a field here with `#[serde(default = ...)]` (so a set
//! stored before it existed still reads), its default constant, its check in
//! [`StageOptions::is_valid`], its field in [`StageOptionsChange`] and its
//! [`StageOptionKey`] (the compiler asks for both in
//! [`StageOptions::apply`]), and its row in the frontend's Options screen.

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
/// The lyric bar's text at #55's size.
pub const LYRIC_SIZE_DEFAULT: LyricSize = LyricSize::M;
/// The next Line shows small under the current one.
pub const SHOW_NEXT_LINE_DEFAULT: bool = true;
/// The least frosted the lane panels go, in percent.
pub const LANE_FROSTING_MIN_PERCENT: u8 = 40;
/// The most frosted the lane panels go, in percent.
pub const LANE_FROSTING_MAX_PERCENT: u8 = 90;
/// One step of the lane frosting, in percent.
pub const LANE_FROSTING_STEP_PERCENT: u8 = 10;
/// #55's frosting, off the 10 % steps: it is kept as the default.
pub const LANE_FROSTING_DEFAULT_PERCENT: u8 = 66;

/// One step of the UI sounds level, in percent.
pub const UI_SOUNDS_STEP_PERCENT: u8 = 10;
/// The Stage's UI and game sounds play at 60 %, under the Song.
pub const UI_SOUNDS_DEFAULT_PERCENT: u8 = 60;

/// How large the lyric bar's text is. `xl` is 1.5 × `m`; the bar grows
/// upward, and the lanes move up rather than be covered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum LyricSize {
    S,
    #[default]
    M,
    L,
    Xl,
}

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
fn lyric_size_default() -> LyricSize {
    LYRIC_SIZE_DEFAULT
}
fn show_next_line_default() -> bool {
    SHOW_NEXT_LINE_DEFAULT
}
fn lane_frosting_default() -> u8 {
    LANE_FROSTING_DEFAULT_PERCENT
}
fn theme_default() -> Theme {
    THEME_DEFAULT
}
fn ui_sounds_default() -> u8 {
    UI_SOUNDS_DEFAULT_PERCENT
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
    /// How large the lyric bar's text is, `s` to `xl`.
    #[serde(default = "lyric_size_default")]
    pub lyric_size: LyricSize,
    /// Whether the next Line shows small under the current one (never in a
    /// duet, which shows both Voices' current Lines).
    #[serde(default = "show_next_line_default")]
    pub show_next_line: bool,
    /// How opaque the lane panels' white frosting is: 66 %, or 40 to 90 %
    /// in 10 % steps.
    #[serde(default = "lane_frosting_default")]
    pub lane_frosting_percent: u8,
    /// How every screen looks; Phones follow the Stage's theme. Its range is
    /// its three values: any other is refused.
    #[serde(default = "theme_default")]
    pub theme: Theme,
    /// How loud the Stage's UI and game sounds play, 0 to 100 % in 10 %
    /// steps, on the OpenStar volume's curve; 0 is off.
    #[serde(default = "ui_sounds_default")]
    pub ui_sounds_percent: u8,
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
            lyric_size: LYRIC_SIZE_DEFAULT,
            show_next_line: SHOW_NEXT_LINE_DEFAULT,
            lane_frosting_percent: LANE_FROSTING_DEFAULT_PERCENT,
            theme: THEME_DEFAULT,
            ui_sounds_percent: UI_SOUNDS_DEFAULT_PERCENT,
        }
    }
}

/// Some of the Stage options: the body of a Phone's `setStageOptions`. A
/// field left out keeps its kept value; each one sent is checked like the
/// whole set's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageOptionsChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub starting_difficulty: Option<Difficulty>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume_countdown_seconds: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_ratings: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effects: Option<Effects>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub song_video: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview_volume_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub skip_intros: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lyric_size: Option<LyricSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_next_line: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lane_frosting_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub theme: Option<Theme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ui_sounds_percent: Option<u8>,
}

/// One Stage option, by its field's name as sent (`"lyricSize"`): what a
/// [`crate::party::PartyEvent::StageOptionsChanged`] names, so the frontend
/// switches over them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StageOptionKey {
    StartingDifficulty,
    ResumeCountdownSeconds,
    LineRatings,
    Effects,
    SongVideo,
    PreviewVolumePercent,
    SkipIntros,
    LyricSize,
    ShowNextLine,
    LaneFrostingPercent,
    Theme,
    UiSoundsPercent,
}

/// `new` when it is sent and differs from `was` (noting `key` in `changed`),
/// else `was`.
fn pick<T: PartialEq>(
    changed: &mut Vec<StageOptionKey>,
    key: StageOptionKey,
    was: T,
    new: Option<T>,
) -> T {
    match new {
        Some(new) if new != was => {
            changed.push(key);
            new
        }
        _ => was,
    }
}

impl StageOptions {
    /// `change` merged onto these options, and the options it changed, in
    /// the order of the fields. A field it names at its current value is not
    /// a change. Checks nothing: see [`StageOptions::is_valid`].
    pub fn apply(self, change: StageOptionsChange) -> (StageOptions, Vec<StageOptionKey>) {
        // Both taken apart in full, so a new option cannot be left out.
        let StageOptionsChange {
            starting_difficulty,
            resume_countdown_seconds,
            line_ratings,
            effects,
            song_video,
            preview_volume_percent,
            skip_intros,
            lyric_size,
            show_next_line,
            lane_frosting_percent,
            theme,
            ui_sounds_percent,
        } = change;
        let StageOptions {
            starting_difficulty: was_starting_difficulty,
            resume_countdown_seconds: was_resume_countdown_seconds,
            line_ratings: was_line_ratings,
            effects: was_effects,
            song_video: was_song_video,
            preview_volume_percent: was_preview_volume_percent,
            skip_intros: was_skip_intros,
            lyric_size: was_lyric_size,
            show_next_line: was_show_next_line,
            lane_frosting_percent: was_lane_frosting_percent,
            theme: was_theme,
            ui_sounds_percent: was_ui_sounds_percent,
        } = self;
        let mut changed = Vec::new();
        let c = &mut changed;
        let after = StageOptions {
            starting_difficulty: pick(
                c,
                StageOptionKey::StartingDifficulty,
                was_starting_difficulty,
                starting_difficulty,
            ),
            resume_countdown_seconds: pick(
                c,
                StageOptionKey::ResumeCountdownSeconds,
                was_resume_countdown_seconds,
                resume_countdown_seconds,
            ),
            line_ratings: pick(
                c,
                StageOptionKey::LineRatings,
                was_line_ratings,
                line_ratings,
            ),
            effects: pick(c, StageOptionKey::Effects, was_effects, effects),
            song_video: pick(c, StageOptionKey::SongVideo, was_song_video, song_video),
            preview_volume_percent: pick(
                c,
                StageOptionKey::PreviewVolumePercent,
                was_preview_volume_percent,
                preview_volume_percent,
            ),
            skip_intros: pick(c, StageOptionKey::SkipIntros, was_skip_intros, skip_intros),
            lyric_size: pick(c, StageOptionKey::LyricSize, was_lyric_size, lyric_size),
            show_next_line: pick(
                c,
                StageOptionKey::ShowNextLine,
                was_show_next_line,
                show_next_line,
            ),
            lane_frosting_percent: pick(
                c,
                StageOptionKey::LaneFrostingPercent,
                was_lane_frosting_percent,
                lane_frosting_percent,
            ),
            theme: pick(c, StageOptionKey::Theme, was_theme, theme),
            ui_sounds_percent: pick(
                c,
                StageOptionKey::UiSoundsPercent,
                was_ui_sounds_percent,
                ui_sounds_percent,
            ),
        };
        (after, changed)
    }

    /// Whether every value is within its range (and on its step).
    pub fn is_valid(&self) -> bool {
        self.resume_countdown_seconds <= RESUME_COUNTDOWN_MAX_SECONDS
            && self.preview_volume_percent <= 100
            && self
                .preview_volume_percent
                .is_multiple_of(PREVIEW_VOLUME_STEP_PERCENT)
            && (self.lane_frosting_percent == LANE_FROSTING_DEFAULT_PERCENT
                || ((LANE_FROSTING_MIN_PERCENT..=LANE_FROSTING_MAX_PERCENT)
                    .contains(&self.lane_frosting_percent)
                    && self
                        .lane_frosting_percent
                        .is_multiple_of(LANE_FROSTING_STEP_PERCENT)))
            && self.ui_sounds_percent <= 100
            && self
                .ui_sounds_percent
                .is_multiple_of(UI_SOUNDS_STEP_PERCENT)
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
    fn a_v1_row_loads_with_the_new_options_at_their_defaults() {
        let v1 = r#"{"startingDifficulty":"medium","resumeCountdownSeconds":3,"lineRatings":true,"effects":true,"songVideo":true,"previewVolumePercent":100}"#;
        let read: StageOptions = serde_json::from_str(v1).unwrap();
        assert_eq!(read, StageOptions::default());
        assert_eq!(read.lyric_size, LyricSize::M);
        assert!(read.show_next_line);
        assert_eq!(read.lane_frosting_percent, 66);
        assert_eq!(read.theme, Theme::BubblePop);
        assert_eq!(read.ui_sounds_percent, 60);
    }

    #[test]
    fn the_lane_frosting_is_its_default_or_40_to_90_in_tens() {
        for percent in [40, 50, 60, 66, 70, 80, 90] {
            let options = StageOptions {
                lane_frosting_percent: percent,
                ..StageOptions::default()
            };
            assert!(options.is_valid(), "{percent}");
        }
        for percent in [0, 30, 35, 45, 65, 67, 95, 100] {
            let options = StageOptions {
                lane_frosting_percent: percent,
                ..StageOptions::default()
            };
            assert!(!options.is_valid(), "{percent}");
        }
    }

    #[test]
    fn the_ui_sounds_level_is_0_to_100_in_tens_and_60_by_default() {
        assert_eq!(StageOptions::default().ui_sounds_percent, 60);
        for percent in [0, 10, 50, 60, 100] {
            let options = StageOptions {
                ui_sounds_percent: percent,
                ..StageOptions::default()
            };
            assert!(options.is_valid(), "{percent}");
        }
        for percent in [5, 55, 65, 110, 255] {
            let options = StageOptions {
                ui_sounds_percent: percent,
                ..StageOptions::default()
            };
            assert!(!options.is_valid(), "{percent}");
        }
    }

    #[test]
    fn a_lyric_size_is_sent_as_its_letter() {
        for (size, text) in [
            (LyricSize::S, "s"),
            (LyricSize::M, "m"),
            (LyricSize::L, "l"),
            (LyricSize::Xl, "xl"),
        ] {
            assert_eq!(serde_json::to_value(size).unwrap(), text);
        }
        assert!(serde_json::from_str::<StageOptions>(r#"{"lyricSize":"xxl"}"#).is_err());
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
    fn a_change_keeps_what_it_leaves_out_and_names_only_what_differs() {
        let kept = StageOptions {
            lyric_size: LyricSize::Xl,
            ..StageOptions::default()
        };
        let (after, changed) = kept.apply(StageOptionsChange {
            show_next_line: Some(false),
            // Sent at its kept value: not a change.
            effects: Some(Effects::Full),
            theme: Some(Theme::HighContrast),
            ..StageOptionsChange::default()
        });
        assert_eq!(
            after,
            StageOptions {
                lyric_size: LyricSize::Xl,
                show_next_line: false,
                theme: Theme::HighContrast,
                ..StageOptions::default()
            }
        );
        assert_eq!(
            changed,
            vec![StageOptionKey::ShowNextLine, StageOptionKey::Theme]
        );
        let (after, changed) = after.clone().apply(StageOptionsChange::default());
        assert_eq!(after.lyric_size, LyricSize::Xl);
        assert!(changed.is_empty());
    }

    #[test]
    fn every_option_has_its_change_field_and_its_key_named_as_sent() {
        let changed = StageOptions {
            starting_difficulty: Difficulty::Hard,
            resume_countdown_seconds: 0,
            line_ratings: false,
            effects: Effects::Off,
            song_video: false,
            preview_volume_percent: 0,
            skip_intros: true,
            lyric_size: LyricSize::S,
            show_next_line: false,
            lane_frosting_percent: 90,
            theme: Theme::BubblePopNight,
            ui_sounds_percent: 0,
        };
        // The whole set read as a change: every field reads.
        let change: StageOptionsChange =
            serde_json::from_value(serde_json::to_value(&changed).unwrap()).unwrap();
        let (after, keys) = StageOptions::default().apply(change);
        assert_eq!(after, changed);
        let serde_json::Value::Object(fields) = serde_json::to_value(&changed).unwrap() else {
            unreachable!()
        };
        let mut names: Vec<String> = keys
            .iter()
            .map(|key| {
                serde_json::to_value(key)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        // The map reads in alphabetical order.
        names.sort();
        assert_eq!(names, fields.keys().cloned().collect::<Vec<_>>());
    }

    #[test]
    fn a_change_sends_only_what_it_names() {
        let change = StageOptionsChange {
            lyric_size: Some(LyricSize::L),
            ..StageOptionsChange::default()
        };
        assert_eq!(
            serde_json::to_value(&change).unwrap(),
            serde_json::json!({ "lyricSize": "l" })
        );
        assert!(serde_json::from_str::<StageOptionsChange>(r#"{"theme":"pink"}"#).is_err());
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
                "lyricSize": "m",
                "showNextLine": true,
                "laneFrostingPercent": 66,
                "theme": "bubblePop",
                "uiSoundsPercent": 60,
            })
        );
    }
}
