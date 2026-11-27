import { writeFile } from "node:fs/promises";

const SAMPLE_RATE = 48_000;

/**
 * Writes a mono 16-bit PCM WAV of a sine tone, for a Phone's fake microphone
 * (Chromium loops it).
 */
export async function writeToneWav(
  path: string,
  hz: number,
  seconds: number,
): Promise<string> {
  const samples = Math.round(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    data.writeInt16LE(Math.round(value * 32_767), i * 2);
  }
  return writeWav(path, data);
}

/**
 * Writes a mono WAV of a voice-like tone around `hz`: a 5.5 Hz vibrato of
 * ±30 cents, sung in 450 ms phrases with a 150 ms breath between them. A
 * Phone mic opens with the browser's noise suppression on, which takes a
 * steady sine for noise and turns it down by about 19 dB; this one it keeps.
 */
export async function writeSungWav(
  path: string,
  hz: number,
  seconds: number,
): Promise<string> {
  const samples = Math.round(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(samples * 2);
  const phrase = 0.6 * SAMPLE_RATE;
  const sung = 0.45 * SAMPLE_RATE;
  const fade = 0.01 * SAMPLE_RATE;
  let phase = 0;
  for (let i = 0; i < samples; i += 1) {
    const cents = 30 * Math.sin((2 * Math.PI * 5.5 * i) / SAMPLE_RATE);
    phase += (2 * Math.PI * hz * 2 ** (cents / 1200)) / SAMPLE_RATE;
    const at = i % phrase;
    const envelope =
      at >= sung ? 0 : Math.min(1, at / fade, (sung - at) / fade);
    const value = 0.6 * envelope * Math.sin(phase);
    data.writeInt16LE(Math.round(value * 32_767), i * 2);
  }
  return writeWav(path, data);
}

async function writeWav(path: string, data: Buffer): Promise<string> {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
  return path;
}
