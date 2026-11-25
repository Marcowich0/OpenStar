//! What the bridge needs from a WAV file's header in `--wav` mode: how many
//! channels it has (each is one hardware channel of one interface) and its
//! sample rate. Plain PCM, IEEE float and `WAVE_FORMAT_EXTENSIBLE` (what
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

    #[test]
    fn not_a_wav_file() {
        assert!(read_format(&b"OggS and so on"[..]).is_err());
        assert!(read_format(&b"RIFF\0\0\0\0WAVE"[..]).is_err());
        assert!(read_format(header(&fmt(0x55, 2, 44_100, 16)).as_slice()).is_err());
    }
}
