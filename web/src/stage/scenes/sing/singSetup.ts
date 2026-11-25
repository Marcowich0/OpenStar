// What a Song's sing screen needs, built once at Start from the Line-up the
// server fixed (#164): one Player per seat, in seat order, with their Party
// colour, Voice, Difficulty and Mic; the Mic-to-Player map the Pitch router
// routes readings by; one scorer per Player; and the `SingState` the render
// loop draws, its lanes reading each Player's ring buffer.

import type { LineUp } from "../../../generated/LineUp";
import type { MicId } from "../../../generated/MicId";
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
import { pitchBufferCapacity } from "../../../pitch/pitchCapacity";
import { createScorer, type Scorer } from "../../../scoring/scorer";
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
   * The relayed Mic id a seated Mic's readings arrive with, or `null` when
   * the Stage cannot tell. Today relayed readings name a Phone's connection,
   * not its Phone id, so the default can name none (see the #164 note).
   */
  micIdFor?: (mic: MicKey) => MicId | null;
  /** The OpenStar volume the Mic thresholds are fixed at. */
  volume?: number;
}

export interface SingSetup {
  players: readonly SingPlayer[];
  /** Which Player each seated Mic sings for (`PitchSession.mics`). */
  mics: readonly (readonly [MicId, number])[];
  /** Readings per Player's buffer (`PitchSession.capacity`). */
  capacity: number;
  /** One per Player, in Player order. */
  scorers: readonly Scorer[];
  /** The sing screen's state, its lanes reading these buffers (one per Player). */
  state: (buffers: readonly PitchBuffer[]) => SingState;
}

const noMicId = (): MicId | null => null;

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

  const micIdFor = input.micIdFor ?? noMicId;
  const mics: [MicId, number][] = [];
  players.forEach((player, index) => {
    const id = player.mic && micIdFor(player.mic);
    if (id) mics.push([id, index]);
  });

  const scorers = players.map((player) => {
    const voice = song.voices[player.voice] ?? { lines: [] };
    return createScorer({
      voice,
      headers: song.headers,
      difficulty: player.difficulty,
    });
  });

  const voices = singVoices(song);
  const layout = laneLayout(players.length);

  return {
    players,
    mics,
    capacity: pitchBufferCapacity(song.headers, layout),
    scorers,
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
