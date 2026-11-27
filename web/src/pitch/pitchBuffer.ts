/**
 * One Player's Pitch readings on the Stage, outside React: a ring buffer of
 * fixed capacity, held as parallel typed arrays so pushing and reading
 * allocate nothing. The scorer and the pitch line read it directly.
 *
 * Each entry is a reading already placed on Song time. Entries are kept in
 * arrival order; a Mic's readings arrive in capture order, so within a Song
 * they are also in Song-time order. Whoever restarts the Song from an earlier
 * point clears the buffer, so that order holds after a Restart too.
 */

import type { PitchReading } from "../generated/PitchReading";

/**
 * Called once per visited reading with its fields as numbers, so visiting
 * allocates nothing. Keep the callback itself out of the frame (a module
 * constant or one made at Song start), or making it allocates each frame.
 */
export type PitchReadingVisitor = (
  songTime: number,
  pitch: number | null,
  clarity: number,
  loudness: number,
  captureMs: number,
) => void;

export class PitchBuffer {
  readonly capacity: number;
  private readonly songTimes: Float64Array;
  /** `NaN` stands for an unvoiced reading's missing pitch. */
  private readonly pitches: Float64Array;
  private readonly clarities: Float64Array;
  private readonly loudnesses: Float64Array;
  private readonly captureMss: Float64Array;
  /** Slot the next reading goes into. */
  private next = 0;
  private count = 0;

  /** Allocates every slot now; the buffer never grows afterwards. */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `capacity must be a whole number ≥ 1: ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    this.songTimes = new Float64Array(capacity);
    this.pitches = new Float64Array(capacity);
    this.clarities = new Float64Array(capacity);
    this.loudnesses = new Float64Array(capacity);
    this.captureMss = new Float64Array(capacity);
  }

  /** How many readings it holds, at most `capacity`. */
  get size(): number {
    return this.count;
  }

  /** Adds `reading`, placed at `songTime`; once full, overwrites the oldest. */
  push(reading: PitchReading, songTime: number): void {
    const slot = this.next;
    this.songTimes[slot] = songTime;
    this.pitches[slot] = reading.pitch ?? Number.NaN;
    this.clarities[slot] = reading.clarity;
    this.loudnesses[slot] = reading.loudness;
    this.captureMss[slot] = reading.captureMs;
    this.next = slot + 1 === this.capacity ? 0 : slot + 1;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Forgets every reading; the slots stay allocated. */
  clear(): void {
    this.next = 0;
    this.count = 0;
  }

  /**
   * Visits, in arrival order, the newest run of readings placed at or after
   * `from` (seconds of Song time). It walks back from the newest reading to
   * the first one before `from`, so the cost follows the readings visited,
   * not the capacity.
   */
  forEachFrom(from: number, visit: PitchReadingVisitor): void {
    let first = this.count;
    while (first > 0 && at(this.songTimes, this.slotOf(first - 1)) >= from) {
      first -= 1;
    }
    for (let i = first; i < this.count; i++)
      this.visitSlot(this.slotOf(i), visit);
  }

  /** Visits the newest arrived reading; `false` when there is none. */
  visitNewest(visit: PitchReadingVisitor): boolean {
    if (this.count === 0) return false;
    this.visitSlot(this.newestSlot(), visit);
    return true;
  }

  /** Song time of the newest arrived reading, `null` when empty. */
  newestSongTime(): number | null {
    return this.count === 0 ? null : at(this.songTimes, this.newestSlot());
  }

  /**
   * Pitch of the newest arrived reading: `null` when it was unvoiced or the
   * buffer is empty (`newestSongTime()` tells the two apart).
   */
  newestPitch(): number | null {
    return this.count === 0
      ? null
      : pitchOrNull(at(this.pitches, this.newestSlot()));
  }

  /** Slot of the `i`-th held reading, oldest first. */
  private slotOf(i: number): number {
    const slot = this.next - this.count + i;
    return slot < 0 ? slot + this.capacity : slot;
  }

  private newestSlot(): number {
    return this.next === 0 ? this.capacity - 1 : this.next - 1;
  }

  private visitSlot(slot: number, visit: PitchReadingVisitor): void {
    visit(
      at(this.songTimes, slot),
      pitchOrNull(at(this.pitches, slot)),
      at(this.clarities, slot),
      at(this.loudnesses, slot),
      at(this.captureMss, slot),
    );
  }
}

/** A held slot's value; every slot below `capacity` exists. */
function at(values: Float64Array, slot: number): number {
  return values[slot] ?? Number.NaN;
}

function pitchOrNull(pitch: number): number | null {
  return Number.isNaN(pitch) ? null : pitch;
}
