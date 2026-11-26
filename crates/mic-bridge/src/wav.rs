//! What the bridge needs from a WAV file in `--wav` mode: how many channels
//! it has (each is one hardware channel of one interface), its sample rate
//! and its samples. Plain PCM, IEEE float and `WAVE_FORMAT_EXTENSIBLE` (what
//! ffmpeg writes for more than two channels) are read.

use std::io::Read;

use anyhow::{Context as _, bail, ensure};

const PCM: u16 = 1;
const IEEE_FLOAT: u16 = 3;
const EXTENSIBLE: u16 = 0xFFFE;

/// A WAV file's format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavFormat {
    pub channels: u16,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
    /// Samples are IEEE floats (otherwise signed integers).
    pub float: bool,
}

/// Reads the format of a WAV file from its header.
pub fn read_format(mut reader: impl Read) -> anyhow::Result<WavFormat> {
    let mut riff = [0_u8; 12];
    reader
        .read_exact(&mut riff)
        .context("not a WAV file: too short")?;
    ensure!(
        &riff[0..4] == b"RIFF" && &riff[8..12] == b"WAVE",
        "not a WAV file: no RIFF/WAVE header"
    );
    loop {
        let mut header = [0_u8; 8];
        reader
            .read_exact(&mut header)
            .context("not a WAV file: no fmt chunk")?;
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        if &header[0..4] != b"fmt " {
            // Chunks are padded to an even size.
            std::io::copy(
                &mut reader.by_ref().take((size + size % 2) as u64),
                &mut std::io::sink(),
            )?;
            continue;
        }
        ensure!(size >= 16, "not a WAV file: its fmt chunk is too short");
        let mut fmt = vec![0_u8; size];
        reader
            .read_exact(&mut fmt)
            .context("not a WAV file: its fmt chunk is cut off")?;
        let u16_at = |i: usize| u16::from_le_bytes([fmt[i], fmt[i + 1]]);
        let mut tag = u16_at(0);
        if tag == EXTENSIBLE {
            ensure!(
                size >= 26,
                "not a WAV file: its extensible fmt chunk is too short"
            );
            // The sub-format GUID starts with the plain format tag.
            tag = u16_at(24);
        }
        let float = match tag {
            PCM => false,
            IEEE_FLOAT => true,
            other => bail!("unsupported WAV sample format {other:#06x}: use PCM or float"),
        };
        let channels = u16_at(2);
        ensure!(channels > 0, "the WAV file has no channels");
        return Ok(WavFormat {
            channels,
            sample_rate: u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]),
            bits_per_sample: u16_at(14),
            float,
        });
    }
}

/// A whole WAV file: its format and every sample, interleaved, as floats
/// in −1..1.
#[derive(Debug, Clone, PartialEq)]
pub struct WavAudio {
    pub format: WavFormat,
    pub samples: Vec<f32>,
}

/// Reads a WAV file's format and samples (8-, 16-, 24- or 32-bit PCM, or
/// 32- or 64-bit float).
pub fn read_audio(mut reader: impl Read) -> anyhow::Result<WavAudio> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    let format = read_format(bytes.as_slice())?;
    let data = data_chunk(&bytes).context("not a WAV file: no data chunk")?;
    let width = usize::from(format.bits_per_sample / 8);
    let decode: fn(&[u8]) -> f32 = match (format.float, format.bits_per_sample) {
        (false, 8) => |b| (f32::from(b[0]) - 128.0) / 128.0,
        (false, 16) => |b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0,
        (false, 24) => |b| (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
        (false, 32) => |b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        (true, 32) => |b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        (true, 64) => {
            |b| f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32
        }
        (float, bits) => bail!(
            "unsupported WAV sample size: {bits}-bit {}",
            if float { "float" } else { "PCM" }
        ),
    };
    let frame = width * usize::from(format.channels);
    let usable = data.len() - data.len() % frame;
    let samples = data[..usable].chunks_exact(width).map(decode).collect();
    Ok(WavAudio { format, samples })
}

/// The bytes of the `data` chunk (cut at the end of the file when its size
/// says more, as streamed WAV files do).
fn data_chunk(bytes: &[u8]) -> Option<&[u8]> {
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = at + 8;
        if &bytes[at..at + 4] == b"data" {
            return Some(&bytes[body..body.saturating_add(size).min(bytes.len())]);
        }
        at = body.checked_add(size + size % 2)?;
    }
    None
}

/// One interface read from a WAV file, played in a loop: each call to
/// [`WavLoop::next_block`] gives the next frames, so read every tenth of a
/// second it runs at the file's own pace.
pub struct WavLoop {
    audio: WavAudio,
    at: usize,
}

impl WavLoop {
    pub fn new(audio: WavAudio) -> Self {
        Self { audio, at: 0 }
    }

    pub fn format(&self) -> WavFormat {
        self.audio.format
    }

    /// The next `frames` frames, interleaved, from the start again after
    /// the end. Empty for a file without samples.
    pub fn next_block(&mut self, frames: usize) -> Vec<f32> {
        let samples = &self.audio.samples;
        if samples.is_empty() {
            return Vec::new();
        }
        let wanted = frames * usize::from(self.audio.format.channels);
        let mut block = Vec::with_capacity(wanted);
        while block.len() < wanted {
            let take = (wanted - block.len()).min(samples.len() - self.at);
            block.extend_from_slice(&samples[self.at..self.at + take]);
            self.at = (self.at + take) % samples.len();
        }
        block
    }
}

/// A WAV file as an interface: its file name is the device name and the
/// label, each of its channels one hardware channel. It plays in real time
/// on the bridge's monotonic clock while open, in a loop, so a Song longer
/// than the file still gets readings. It reports no input delay.
pub struct WavInput {
    interface: openstar_protocol::bridge::BridgeInterface,
    wav: WavLoop,
    /// While open: when the stream started (ms) and how many frames it has
    /// given since.
    playing: Option<(f64, u64)>,
}

impl WavInput {
    pub fn new(name: String, audio: WavAudio) -> Self {
        Self {
            interface: openstar_protocol::bridge::BridgeInterface {
                device_name: name.clone(),
                label: name,
                channels: u32::from(audio.format.channels),
            },
            wav: WavLoop::new(audio),
            playing: None,
        }
    }
}

impl crate::client::Input for WavInput {
    fn interface(&self) -> &openstar_protocol::bridge::BridgeInterface {
        &self.interface
    }

    fn sample_rate(&self) -> f64 {
        f64::from(self.wav.format().sample_rate)
    }

    fn read(&mut self, now_ms: f64) -> Vec<f32> {
        let rate = self.sample_rate();
        let (started, given) = self.playing.get_or_insert((now_ms, 0));
        let due = ((now_ms - *started).max(0.0) * rate / 1000.0).floor() as u64;
        let frames = due.saturating_sub(*given);
        *given += frames;
        self.wav.next_block(frames as usize)
    }

    fn close(&mut self) {
        self.playing = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A WAV header with a `LIST` chunk before `fmt `, as ffmpeg writes it.
    fn header(fmt: &[u8]) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WAVE".to_vec();
        out.extend_from_slice(b"LIST\x03\0\0\0abc\0");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        out.extend_from_slice(fmt);
        out.extend_from_slice(b"data\0\0\0\0");
        out
    }

    fn fmt(tag: u16, channels: u16, rate: u32, bits: u16) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * u32::from(bits / 8)).to_le_bytes());
        out.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        out.extend_from_slice(&bits.to_le_bytes());
        out
    }

    #[test]
    fn plain_pcm() {
        let format = read_format(header(&fmt(1, 2, 44_100, 16)).as_slice()).unwrap();
        assert_eq!(
            format,
            WavFormat {
                channels: 2,
                sample_rate: 44_100,
                bits_per_sample: 16,
                float: false
            }
        );
    }

    #[test]
    fn extensible_float_with_four_channels() {
        let mut chunk = fmt(EXTENSIBLE, 4, 48_000, 32);
        chunk.extend_from_slice(&22_u16.to_le_bytes()); // cbSize
        chunk.extend_from_slice(&32_u16.to_le_bytes()); // valid bits
        chunk.extend_from_slice(&0_u32.to_le_bytes()); // channel mask
        chunk.extend_from_slice(&IEEE_FLOAT.to_le_bytes());
        chunk.extend_from_slice(&[0; 14]);
        let format = read_format(header(&chunk).as_slice()).unwrap();
        assert_eq!((format.channels, format.float), (4, true));
    }

    /// A 16-bit PCM file with `channels` channels and these samples.
    fn pcm16(channels: u16, samples: &[i16]) -> Vec<u8> {
        let mut out = header(&fmt(1, channels, 48_000, 16));
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let size_at = out.len() - 4;
        out[size_at..].copy_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    #[test]
    fn samples_are_read_interleaved_as_floats() {
        let audio = read_audio(pcm16(2, &[16_384, -32_768, 0, 8_192]).as_slice()).unwrap();
        assert_eq!(audio.format.channels, 2);
        assert_eq!(audio.samples, vec![0.5, -1.0, 0.0, 0.25]);
    }

    #[test]
    fn a_wav_loop_starts_again_after_the_end() {
        let audio = read_audio(pcm16(2, &[16_384, 0, 8_192, 0]).as_slice()).unwrap();
        let mut wav = WavLoop::new(audio);
        assert_eq!(wav.next_block(3), vec![0.5, 0.0, 0.25, 0.0, 0.5, 0.0]);
        assert_eq!(wav.next_block(1), vec![0.25, 0.0]);
    }

    #[test]
    fn a_wav_input_gives_the_frames_due_since_it_opened_in_real_time() {
        use crate::client::Input as _;
        let samples: Vec<i16> = (0..48_000 * 2).map(|n| (n % 100) as i16).collect();
        let mut input = WavInput::new(
            "x.wav".into(),
            read_audio(pcm16(2, &samples).as_slice()).unwrap(),
        );
        assert_eq!(input.sample_rate(), 48_000.0);
        assert_eq!(input.input_delay_ms(0), None);
        // The first read opens the stream.
        assert!(input.read(1_000.0).is_empty());
        assert_eq!(input.read(1_100.0).len(), 4_800 * 2);
        assert!(input.read(1_100.0).is_empty());
        // A fraction of a frame waits for the next read.
        assert_eq!(input.read(1_110.51).len(), 504 * 2);
        assert_eq!(input.read(1_110.53).len(), 2);
        // Past the file's one second it starts again from the top.
        let block = input.read(2_500.0);
        assert_eq!(block.len(), (72_000 - 5_305) * 2);
        // Closed and opened again: paced from the new start.
        input.close();
        assert!(input.read(9_000.0).is_empty());
        assert_eq!(input.read(9_010.0).len(), 480 * 2);
    }

    #[test]
    fn not_a_wav_file() {
        assert!(read_format(&b"OggS and so on"[..]).is_err());
        assert!(read_format(&b"RIFF\0\0\0\0WAVE"[..]).is_err());
        assert!(read_format(header(&fmt(0x55, 2, 44_100, 16)).as_slice()).is_err());
    }
}
