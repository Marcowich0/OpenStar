import type { PhoneId } from "../generated/PhoneId";
import type { ProfileId } from "../generated/ProfileId";

/** The part of `localStorage` the Phone id needs. */
export type PhoneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PHONE_ID_KEY = "openstar.phoneId";
const PROFILE_ID_KEY = "openstar.profileId";

/** Made when storage cannot keep one, so the page still works until reload. */
let pageOnlyId: PhoneId | null = null;

/**
 * This browser's Phone id: made at random on its first visit and kept in
 * local storage, so every join and reconnect presents the same one. Clearing
 * the browser's storage makes it a new Phone.
 */
export function phoneId(
  storage: PhoneStorage,
  makeId: () => string = randomUuid,
): PhoneId {
  try {
    const kept = storage.getItem(PHONE_ID_KEY);
    if (kept) return kept;
    const made = makeId();
    storage.setItem(PHONE_ID_KEY, made);
    return made;
  } catch {
    pageOnlyId ??= makeId();
    return pageOnlyId;
  }
}

/**
 * A random version 4 UUID. Built from `crypto.getRandomValues`, because
 * `crypto.randomUUID` exists only on HTTPS and a Phone may open OpenStar over
 * plain HTTP on the local network.
 */
function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * The Profile this Phone last joined as, kept apart from the Phone id. Only
 * the Phone remembers it; the server keeps no lasting Phone-to-Profile link.
 */
export function rememberedProfileId(storage: PhoneStorage): ProfileId | null {
  try {
    const kept = storage.getItem(PROFILE_ID_KEY);
    if (kept === null || !/^\d+$/.test(kept)) return null;
    return Number(kept);
  } catch {
    return null;
  }
}

/** Remembers the Profile this Phone joined as, for the next join. */
export function rememberProfile(storage: PhoneStorage, id: ProfileId): void {
  try {
    storage.setItem(PROFILE_ID_KEY, String(id));
  } catch {
    // Not remembered: the Phone picks from the list next time.
  }
}

/** Forgets the remembered Profile (for example once it no longer exists). */
export function forgetRememberedProfile(storage: PhoneStorage): void {
  try {
    storage.removeItem(PROFILE_ID_KEY);
  } catch {
    // Nothing kept to forget.
  }
}
