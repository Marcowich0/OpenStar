import { useState } from "react";

import { api } from "../api/api";
import { GuardedButton } from "../guarded/GuardedButton";
import { t } from "../i18n/t";

/**
 * The test-only guarded action, in the test build `admin-test.html` for the
 * Playwright check (#185). It sends `POST /api/unlock/heartbeat`, an endpoint
 * the real binary guards, so the whole flow runs against the real guard
 * without a test-only route on the server. It changes nothing.
 */
export function TestGuardedAction() {
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col items-start gap-3">
      <GuardedButton
        action={() => api("POST /api/unlock/heartbeat")}
        onDone={() => {
          setDone(true);
        }}
      >
        {t("admin.testGuarded")}
      </GuardedButton>
      <p role="status" className="text-lg font-semibold">
        {done ? t("admin.testGuardedDone") : null}
      </p>
    </div>
  );
}
