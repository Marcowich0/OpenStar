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
