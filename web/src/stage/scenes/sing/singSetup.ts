// What a Song's sing screen needs, built once at Start from the Line-up the
// server fixed (#164): one Player per seat, in seat order, with their Party
// colour, Voice, Difficulty and Mic; the Mic-to-Player map the Pitch router
// routes readings by; and the `SingState` the render loop draws, its lanes
// reading each Player's ring buffer. The live scoring session (#165,
// `scoring/liveScoring.ts`) takes each Player's scoring inputs from here.

import type { LineUp } from "../../../generated/LineUp";
import type { MicKey } from "../../../generated/MicKey";
import type { Difficulty } from "../../../generated/Difficulty";
import type { PartyMemberId } from "../../../generated/PartyMemberId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import type { SongDetail } from "../../../generated/SongDetail";
import { resolveMicSettings, type MicKind } from "../../../mics/micSettings";
import { OPENSTAR_VOLUME } from "../../../playback/gain";
import { memberLook } from "../../../phone/memberLook";
import type { PitchBuffer } from "../../../pitch/pitchBuffer";
import type { PitchMic } from "../../../pitch/pitchRouter";
import { pitchBufferCapacity } from "../../../pitch/pitchCapacity";
import type { PaletteKey } from "../../../theme/tokens";
import { EFFECTS_CAPACITY, ParticlePool } from "../../sing/effects";
import {
  singVoices,
  type LanePlayer,
  type SingLane,
  type SingState,
} from "../../sing/frame";
import { laneLayout } from "../../sing/laneLayout";

/** One seated Player of the Song, in seat order. */
export interface SingPlayer {
  memberId: PartyMemberId;
  colour: PaletteKey;
  /** Index into the parsed Song's `voices` (0 = `P1`). */
  voice: number;
  difficulty: Difficulty;
  mic: MicKey | null;
  /** What the Player sings into, for the Score record. */
  micKind: MicKind;
  /** The lane header's look; `undefined` while a Profile's look is unknown. */
  look: LanePlayer | undefined;
  /** The Mic delay used to place this Player's readings, ms. */
  micDelayMs: number;
  /** The effective Mic threshold, fixed at Start, dBFS. */
  micThresholdDbfs: number;
}

export interface SingSetupInput {
  detail: SongDetail;
  /** The Party as the server reported Start: its `lineUp` is fixed for the Song. */
  party: PartySnapshot;
  profiles: readonly Profile[] | undefined;
  /**
   * The Mic a seated Mic's readings reach the Pitch router as, or `null`
   * when none arrive. The default, `pitchMicFor`, names a Phone by its Phone
   * id and a Local mic by its Local mic id.
   */
  micIdFor?: (mic: MicKey) => PitchMic | null;
  /** The OpenStar volume the Mic thresholds are fixed at. */
  volume?: number;
}

export interface SingSetup {
  players: readonly SingPlayer[];
  /** Which Player each seated Mic sings for (`PitchSession.mics`). */
  mics: readonly (readonly [PitchMic, number])[];
  /** Readings per Player's buffer (`PitchSession.capacity`). */
  capacity: number;
  /** The sing screen's state, its lanes reading these buffers (one per Player). */
  state: (buffers: readonly PitchBuffer[]) => SingState;
}

/**
 * The Mic a seated Mic's readings reach the Pitch router as: a Phone's
 * relayed readings carry its Phone id; a Stage-browser Local mic's are
 * delivered on the Stage page under its Local mic id (#130). A Mic bridge
 * Local mic's readings, once relayed (#151), should arrive under the same id.
 */
export function pitchMicFor(mic: MicKey): PitchMic {
  return mic.kind === "phone"
    ? { kind: "phone", phoneId: mic.phoneId }
    : { kind: "localMic", localMicId: mic.localMicId };
}

function micKind(mic: MicKey | null): MicKind {
  return mic?.kind === "localMic" ? "localMic" : "phone";
}

export function singSetup(input: SingSetupInput): SingSetup {
  const { detail, party } = input;
  const lineUp: LineUp | null = party.lineUp;
  if (!lineUp) throw new Error("Start without a Line-up");
  const song = detail.song;
  const volume = input.volume ?? OPENSTAR_VOLUME.default;
  const lastVoice = Math.max(song.voices.length - 1, 0);

  const players: SingPlayer[] = lineUp.seats.map((seat) => {
    const member = party.members.find((m) => m.memberId === seat.memberId);
    const look = member && memberLook(member, input.profiles);
    // #169 applies each Mic's stored values; until then the defaults.
    const settings = resolveMicSettings({
      kind: micKind(seat.mic),
      stored: undefined,
      volume,
    });
    return {
      memberId: seat.memberId,
      colour: member?.colour ?? "cherry",
      voice: Math.min(seat.voice === "p2" ? 1 : 0, lastVoice),
      difficulty: seat.difficulty,
      mic: seat.mic,
      micKind: micKind(seat.mic),
      look: look
        ? {
            name: look.name,
            avatar: look.avatar,
            guest: member.identity.kind === "guest",
            score: 0,
          }
        : undefined,
      micDelayMs: settings.micDelayMs,
      micThresholdDbfs: settings.effectiveThresholdDbfs,
    };
  });

  const micIdFor = input.micIdFor ?? pitchMicFor;
  const mics: [PitchMic, number][] = [];
  players.forEach((player, index) => {
    const id = player.mic && micIdFor(player.mic);
    if (id) mics.push([id, index]);
  });

  const voices = singVoices(song);
  const layout = laneLayout(players.length);

  return {
    players,
    mics,
    capacity: pitchBufferCapacity(song.headers, layout),
    state: (buffers) => ({
      grid: song.headers,
      voices,
      lengthSeconds: detail.lengthSeconds,
      effects: new ParticlePool(EFFECTS_CAPACITY),
      lanes: players.map((player, index): SingLane => {
        const readings = buffers[index];
        return {
          colour: player.colour,
          voice: player.voice,
          ...(player.look ? { player: player.look } : {}),
          ...(readings
            ? {
                trace: {
                  readings,
                  micThresholdDbfs: player.micThresholdDbfs,
                  difficulty: player.difficulty,
                  lostAt: null,
                },
              }
            : {}),
        };
      }),
    }),
  };
}
