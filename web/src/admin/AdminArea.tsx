// `/admin`: the Admin area (v1 spec #45). Anyone may open it and look at every
// section; only a guarded action asks for the Admin PIN (`guarded/`). While
// the browser holds an Unlock it shows Lock, and while it is visible it keeps
// the Unlock alive with the heartbeat.
//
// Nothing on the Stage links here: on the Stage computer the Admin area opens
// in its own browser tab, so `/stage` is never navigated away from.

import { Link, Outlet } from "@tanstack/react-router";

import { useUnlockHeartbeat } from "../guarded/useUnlockHeartbeat";
import { t } from "../i18n/t";
import { Icon } from "../ui/Icon";
import { LockButton } from "./LockButton";

export const ADMIN_SECTIONS = [
  { to: "/admin/downloads", label: "admin.downloads" },
  { to: "/admin/songs", label: "admin.songs" },
  { to: "/admin/library-problems", label: "admin.libraryProblems" },
  { to: "/admin/profiles", label: "admin.profiles" },
] as const;

export function AdminArea() {
  useUnlockHeartbeat();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <Link
          to="/admin"
          className="flex items-center gap-2 rounded-full text-4xl font-bold outline-none focus-visible:outline-6 focus-visible:outline-yellow"
        >
          <Icon name="lock" className="size-8" />
          {t("admin.title")}
        </Link>
        <LockButton />
      </header>
      <nav aria-label={t("admin.sections")}>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ADMIN_SECTIONS.map(({ to, label }) => (
            <li key={to} className="min-w-0">
              <Link
                to={to}
                className="flex min-h-14 items-center justify-center rounded-full bg-white px-3 text-center text-lg font-semibold text-ink shadow-ledge outline-none focus-visible:outline-6 focus-visible:outline-yellow data-[status=active]:bg-ink data-[status=active]:text-white data-[status=active]:shadow-ledge-ink"
              >
                {t(label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </main>
  );
}
