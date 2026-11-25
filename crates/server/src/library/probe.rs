//! What `ffprobe` says about a media file, and whether the Stage plays it.
//!
//! Whether a file plays natively is decided by its container and codecs,
//! never by its extension. The Stage is Chromium with proprietary codecs (v1
//! spec, Assumptions): it plays the containers MP4/M4A/MOV, WebM, Ogg,
//! Matroska, MP3, FLAC and WAV, the audio codecs AAC, MP3, Vorbis, Opus, FLAC
//! and PCM, and the video codecs H.264, VP8, VP9 and AV1. Anything else needs
//! conversion.

use serde::Deserialize;

/// The container and codecs of one media file.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Probe {
    /// ffprobe's `format_name`, for example `mov,mp4,m4a,3gp,3g2,mj2`.
    /// `None` when ffprobe could not read the file.
    pub container: Option<String>,
    /// The codec of the first audio stream.
    pub audio_codec: Option<String>,
    /// The codec of the first video stream that is not an attached picture
    /// (the cover art in an MP3 or M4A is one).
    pub video_codec: Option<String>,
    pub duration_seconds: Option<f64>,
}

/// ffprobe's demuxer names the Stage plays (`format_name` lists several).
const NATIVE_CONTAINERS: &[&str] = &[
    "mov", "mp4", "m4a", "webm", "matroska", "ogg", "mp3", "flac", "wav",
];
const NATIVE_AUDIO: &[&str] = &["aac", "mp3", "vorbis", "opus", "flac"];
const NATIVE_VIDEO: &[&str] = &["h264", "vp8", "vp9", "av1"];

impl Probe {
    /// The probe of a file ffprobe could not read: it needs conversion (and
    /// the conversion will say whether it can be played at all).
    pub(crate) fn unreadable() -> Self {
        Self::default()
    }

    /// Reads ffprobe's `-print_format json -show_format -show_streams` output.
    pub(crate) fn from_ffprobe_json(json: &str) -> Self {
        let Ok(output) = serde_json::from_str::<Output>(json) else {
            return Self::unreadable();
        };
        let first = |kind: &str| {
            output
                .streams
                .iter()
                .find(|s| {
                    s.codec_type.as_deref() == Some(kind)
                        && s.disposition.as_ref().is_none_or(|d| d.attached_pic == 0)
                })
                .and_then(|s| s.codec_name.clone())
        };
        let format = output.format.unwrap_or_default();
        Self {
            container: format.format_name,
            audio_codec: first("audio"),
            video_codec: first("video"),
            duration_seconds: format
                .duration
                .and_then(|d| d.parse::<f64>().ok())
                .filter(|d| d.is_finite() && *d >= 0.0),
        }
    }

    /// Whether the Stage plays this file as it is.
    pub(crate) fn native(&self) -> bool {
        let Some(container) = &self.container else {
            return false;
        };
        let container_ok = container
            .split(',')
            .any(|name| NATIVE_CONTAINERS.contains(&name));
        let audio_ok = self.audio_codec.as_deref().is_none_or(native_audio);
        let video_ok = self
            .video_codec
            .as_deref()
            .is_none_or(|codec| NATIVE_VIDEO.contains(&codec));
        let has_stream = self.audio_codec.is_some() || self.video_codec.is_some();
        container_ok && audio_ok && video_ok && has_stream
    }
}

fn native_audio(codec: &str) -> bool {
    NATIVE_AUDIO.contains(&codec) || codec.starts_with("pcm_")
}

#[derive(Deserialize)]
struct Output {
    #[serde(default)]
    streams: Vec<Stream>,
    format: Option<Format>,
}

#[derive(Deserialize)]
struct Stream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    disposition: Option<Disposition>,
}

#[derive(Deserialize)]
struct Disposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Deserialize, Default)]
struct Format {
    format_name: Option<String>,
    duration: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(container: &str, audio: Option<&str>, video: Option<&str>) -> Probe {
        Probe {
            container: Some(container.into()),
            audio_codec: audio.map(Into::into),
            video_codec: video.map(Into::into),
            duration_seconds: None,
        }
    }

    #[test]
    fn reads_ffprobe_output() {
        let json = r#"{
            "streams": [
                {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
                {"codec_type": "audio", "codec_name": "mp3", "disposition": {"attached_pic": 0}},
                {"codec_type": "video", "codec_name": "h264"}
            ],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "212.480000"}
        }"#;
        assert_eq!(
            Probe::from_ffprobe_json(json),
            Probe {
                container: Some("mov,mp4,m4a,3gp,3g2,mj2".into()),
                audio_codec: Some("mp3".into()),
                video_codec: Some("h264".into()),
                duration_seconds: Some(212.48),
            }
        );
        assert_eq!(Probe::from_ffprobe_json("{\n\n}"), Probe::unreadable());
        assert_eq!(Probe::from_ffprobe_json("not json"), Probe::unreadable());
    }

    #[test]
    fn an_attached_picture_is_not_video() {
        let json = r#"{"streams": [
            {"codec_type": "audio", "codec_name": "mp3"},
            {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}
        ], "format": {"format_name": "mp3"}}"#;
        let probe = Probe::from_ffprobe_json(json);
        assert_eq!(probe.video_codec, None);
        assert!(probe.native());
    }

    #[test]
    fn the_stage_plays_the_listed_containers_and_codecs() {
        for container in [
            "mov,mp4,m4a,3gp,3g2,mj2",
            "matroska,webm",
            "ogg",
            "mp3",
            "flac",
            "wav",
        ] {
            assert!(probe(container, Some("aac"), None).native(), "{container}");
        }
        for audio in [
            "aac",
            "mp3",
            "vorbis",
            "opus",
            "flac",
            "pcm_s16le",
            "pcm_f32le",
        ] {
            assert!(
                probe("matroska,webm", Some(audio), None).native(),
                "{audio}"
            );
        }
        for video in ["h264", "vp8", "vp9", "av1"] {
            assert!(
                probe("matroska,webm", Some("opus"), Some(video)).native(),
                "{video}"
            );
            assert!(
                probe("mov,mp4,m4a,3gp,3g2,mj2", None, Some(video)).native(),
                "{video}"
            );
        }
    }

    #[test]
    fn anything_else_needs_conversion() {
        for container in ["avi", "asf", "flv", "mpeg", "mpegts"] {
            assert!(
                !probe(container, Some("aac"), Some("h264")).native(),
                "{container}"
            );
        }
        for audio in ["wmav2", "ac3", "mp2", "alac"] {
            assert!(
                !probe("mov,mp4,m4a,3gp,3g2,mj2", Some(audio), None).native(),
                "{audio}"
            );
        }
        for video in [
            "mpeg4",
            "msmpeg4v3",
            "mpeg1video",
            "mpeg2video",
            "theora",
            "hevc",
            "wmv2",
        ] {
            assert!(
                !probe("matroska,webm", Some("aac"), Some(video)).native(),
                "{video}"
            );
        }
        assert!(!Probe::unreadable().native());
        assert!(!probe("mp3", None, None).native(), "no stream at all");
    }
}
