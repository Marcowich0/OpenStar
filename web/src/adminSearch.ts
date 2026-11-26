/** The search parameters of `/admin` (the Admin area's home). */
export interface AdminSearch {
  /**
   * `?test=guarded` shows the test-only guarded action the Playwright check
   * uses (#185). It sends only an endpoint that changes nothing.
   */
  test?: "guarded" | undefined;
}

/**
 * Keeps `test=guarded` and drops anything else. The router merges the raw
 * search into what this returns, so a dropped value is returned as
 * `undefined` to override it.
 */
export function validateAdminSearch(
  search: Record<string, unknown>,
): AdminSearch {
  return { test: search["test"] === "guarded" ? "guarded" : undefined };
}
