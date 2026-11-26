import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../api/api";
import { GuardedButton } from "../guarded/GuardedButton";
import { t } from "../i18n/t";
import { Card } from "../ui/Card";
import { ADMIN_SECTIONS } from "./AdminArea";

/** `/admin` with no section chosen: what the Admin area is, and its sections. */
export function AdminHome() {
  const { test } = useSearch({ from: "/admin/" });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg text-ink-2">{t("admin.intro")}</p>
      <ul className="flex flex-col gap-3">
        {ADMIN_SECTIONS.map(({ to, label }) => (
          <li key={to}>
            <Link
              to={to}
              className="block rounded-card-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
            >
              <Card radius="small" className="p-5 text-2xl font-semibold">
                {t(label)}
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      {test === "guarded" ? <TestGuardedAction /> : null}
    </div>
  );
}

/**
 * The test-only guarded action, shown only at `/admin?test=guarded` for the
 * Playwright check (#185). It sends `POST /api/unlock/heartbeat`, an endpoint
 * the real binary guards, so the whole flow runs against the real guard
 * without a test-only route on the server. It changes nothing.
 */
function TestGuardedAction() {
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
