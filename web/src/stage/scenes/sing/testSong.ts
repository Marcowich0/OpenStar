// Test data for the sing scene's tests: a made-up Song detail and Party.
// Placeholder lyrics only.

import type { LineUp } from "../../../generated/LineUp";
import type { Note } from "../../../generated/Note";
import type { PartyMember } from "../../../generated/PartyMember";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import type { Seat } from "../../../generated/Seat";
import type { SongDetail } from "../../../generated/SongDetail";
import type { SongHeaders } from "../../../generated/SongHeaders";
import type { Voice } from "../../../generated/Voice";

function note(start: number, pitch: number): Note {
  return { kind: "normal", start, length: 4, pitch, text: "la ", line: 1 };
}

function voice(pitch: number): Voice {
  return {
    lines: [
      { notes: [note(0, pitch), note(4, pitch)], end: { beat: 10, line: 3 } },
      { notes: [note(12, pitch)], end: null },
    ],
  };
}

export function testHeaders(over: Partial<SongHeaders> = {}): SongHeaders {
  return {
    generation: "v1",
    version: null,
    encoding: null,
    title: "Test Song",
    artist: "Test Artist",
    audioReference: "song.ogg",
    mp3: "song.ogg",
    audio: null,
    video: null,
    cover: null,
    background: null,
    vocals: null,
    instrumental: null,
    beatsPerMinute: 240,
    gapSeconds: 1,
    startSeconds: null,
    endSeconds: null,
    videoGapSeconds: null,
    previewStartSeconds: null,
    medleyStartBeat: null,
    medleyEndBeat: null,
    year: null,
    genre: null,
    genres: [],
    language: null,
    languages: [],
    edition: null,
    editions: [],
    creator: null,
    creators: [],
    p1: null,
    p2: null,
    unknownHeaders: [],
    ...over,
  };
}

export function testDetail(
  options: { duet?: boolean; headers?: Partial<SongHeaders>; id?: number } = {},
): SongDetail {
  return {
    id: options.id ?? 7,
    path: "Test Artist - Test Song/song.txt",
    song: {
      headers: testHeaders(options.headers),
      voices: options.duet ? [voice(0), voice(7)] : [voice(0)],
    },
    noteFingerprint: "f1ng3rpr1nt",
    identity: {
      kind: "artistTitle",
      artist: "test artist",
      title: "test song",
      duet: false,
    },
    lengthSeconds: 30,
    preparing: false,
    media: {
      audio: { url: "/api/songs/7/media/audio", native: true },
      video: null,
      cover: null,
      background: null,
      tileColour: "navy",
    },
    loudnessLufs: -14,
    warnings: [],
  } as unknown as SongDetail;
}

export const MIA: PartyMember = {
  memberId: 1,
  identity: { kind: "profile", profileId: 11 },
  colour: "cherry",
  favouriteTaken: false,
  onPhone: true,
  singing: true,
};

export const LEO: PartyMember = {
  memberId: 2,
  identity: {
    kind: "guest",
    name: "Leo",
    avatar: { kind: "builtIn", key: "cat" },
    difficulty: "medium",
  },
  colour: "sky",
  favouriteTaken: false,
  onPhone: false,
  singing: true,
};

export const PROFILES = [
  { id: 11, name: "Mia", avatar: { kind: "builtIn", key: "star" } },
] as unknown as Profile[];

export const MIA_SEAT: Seat = {
  memberId: 1,
  mic: { kind: "phone", phoneId: "phone-mia" },
  voice: "p1",
  difficulty: "hard",
};

export const LEO_SEAT: Seat = {
  memberId: 2,
  mic: { kind: "localMic", localMicId: "browser:s:dongle:0" },
  voice: "p2",
  difficulty: "easy",
};

export function testLineUp(seats: Seat[], duet = false): LineUp {
  return { requestId: 5, duet, seats, canStart: true, warnings: [] };
}

export function testParty(over: Partial<PartySnapshot> = {}): PartySnapshot {
  return {
    partyId: "party-1",
    stageId: "main",
    joinCode: "4821",
    startedAtMs: 1,
    members: [MIA, LEO],
    phones: [{ phoneId: "phone-mia", memberId: 1 }],
    queue: [
      {
        requestId: 5,
        kind: "song",
        songId: 7,
        requestedPlayers: [],
        adder: null,
      },
    ],
    head: 5,
    lineUp: testLineUp([MIA_SEAT]),
    playing: null,
    results: null,
    localMics: [],
    ...over,
  };
}
