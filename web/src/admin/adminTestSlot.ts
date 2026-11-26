// What a test-only build adds to the Admin area's home: the production app
// never fills the slot, so nothing test-only is in its bundle
// (`codeSplit.test.ts`). `web/admin-test.html` (`src/adminTest/`) fills it
// with the guarded action the Playwright check uses (#185).

import type { ReactNode } from "react";

let slot: ReactNode = null;

/** Test builds and tests only: what the Admin area's home shows under its sections. */
export function setAdminTestSlot(content: ReactNode): void {
  slot = content;
}

/** What the Admin area's home shows under its sections, if a test build set it. */
export function adminTestSlot(): ReactNode {
  return slot;
}
