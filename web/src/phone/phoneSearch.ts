/** The search parameters of the Phone route `/`. */
export interface PhoneSearch {
  /** A Join code from the QR link `/?join=<code>`: the join flow skips the number pad. */
  join?: string | undefined;
}

/** A Join code is 4 digits. */
const JOIN_CODE = /^\d{4}$/;

/**
 * Validates the Phone route's search: a well-formed Join code is kept and a
 * malformed one is dropped. The router merges the raw search into what this
 * returns, so a dropped code is returned as `undefined` to override it.
 */
export function validatePhoneSearch(
  search: Record<string, unknown>,
): PhoneSearch {
  const raw = search["join"];
  // The router JSON-parses search values, so `?join=4271` arrives as a number.
  const join =
    typeof raw === "number" && Number.isInteger(raw) ? String(raw) : raw;
  return typeof join === "string" && JOIN_CODE.test(join)
    ? { join }
    : { join: undefined };
}
