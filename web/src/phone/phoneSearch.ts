/** The search parameters of the Phone route `/`. */
export interface PhoneSearch {
  /**
   * The text after `/?join=` from the QR link. It is kept even when it is no
   * Join code, so that the Phone can say "That code is not on the Stage".
   */
  join?: string | undefined;
}

/** A Join code is 4 digits. */
const JOIN_CODE = /^\d{4}$/;

/** Whether `text` has the form of a Join code. */
export function isJoinCode(text: string): boolean {
  return JOIN_CODE.test(text);
}

/**
 * Validates the Phone route's search: any text after `join=` is kept (the
 * join flow refuses one that is no Join code), anything else is dropped.
 * The router merges the raw search into what this returns, so a dropped
 * value is returned as `undefined` to override it.
 */
export function validatePhoneSearch(
  search: Record<string, unknown>,
): PhoneSearch {
  const raw = search["join"];
  // The router JSON-parses search values, so `?join=4271` arrives as a number.
  const join =
    typeof raw === "number" && Number.isInteger(raw) ? String(raw) : raw;
  return typeof join === "string" && join !== ""
    ? { join }
    : { join: undefined };
}
