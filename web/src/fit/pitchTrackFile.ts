// Reads a downloaded Pitch track (`GET /api/songs/{id}/pitch-track`) into the
// shape the fit module takes. The server sends the cache file's frames as they
// are stored: one frame every 10 ms of three little-endian f32 values, pitch
// (Hz, 0 = unvoiced), clarity and RMS envelope, in that order. The layout is
// pinned by `fixtures/pitch-track/frames.json`, shared with the Rust writer.

import { apiBytes } from "../api/api";
import type { SongId } from "../generated/SongId";
import { FRAME_SECONDS, type PitchFrames } from "./fit";

/** A Song's Pitch track: one value per 10 ms frame in each array. */
export interface PitchTrack extends PitchFrames {
  readonly frameSeconds: number;
  /** Hz, 0 for an unvoiced frame. */
  readonly pitch: Float32Array;
  readonly clarity: Float32Array;
  /** RMS envelope, for the editor's waveform. */
  readonly envelope: Float32Array;
}

const FRAME_BYTES = 12;

/** Decodes the frames of a downloaded Pitch track. */
export function readPitchTrack(bytes: ArrayBuffer): PitchTrack {
  if (bytes.byteLength % FRAME_BYTES !== 0) {
    throw new Error(
      `a Pitch track is whole 12-byte frames, got ${String(bytes.byteLength)} bytes`,
    );
  }
  const frames = bytes.byteLength / FRAME_BYTES;
  const view = new DataView(bytes);
  const pitch = new Float32Array(frames);
  const clarity = new Float32Array(frames);
  const envelope = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = i * FRAME_BYTES;
    pitch[i] = view.getFloat32(at, true);
    clarity[i] = view.getFloat32(at + 4, true);
    envelope[i] = view.getFloat32(at + 8, true);
  }
  return { frameSeconds: FRAME_SECONDS, pitch, clarity, envelope };
}

/**
 * Downloads the Song's cached Pitch track. Ask for it first with
 * `POST /api/songs/{id}/pitch-track` and wait for its job; without a current
 * track this rejects with an `ApiFailure` (404).
 */
export async function downloadPitchTrack(
  song: SongId,
  signal?: AbortSignal,
): Promise<PitchTrack> {
  const bytes = await apiBytes("GET /api/songs/{id}/pitch-track", {
    params: { id: String(song) },
    ...(signal ? { signal } : {}),
  });
  return readPitchTrack(bytes);
}
