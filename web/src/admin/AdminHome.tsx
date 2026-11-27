import { Link } from "@tanstack/react-router";

import { t } from "../i18n/t";
import { Card } from "../ui/Card";
import { ADMIN_SECTIONS } from "./AdminArea";
import { adminTestSlot } from "./adminTestSlot";

/** `/admin` with no section chosen: what the Admin area is, and its sections. */
export function AdminHome() {
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
      {adminTestSlot()}
    </div>
  );
}
