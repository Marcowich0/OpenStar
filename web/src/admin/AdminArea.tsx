import { Link, Outlet } from "@tanstack/react-router";

import { t } from "../i18n/t";

/** `/admin`: the Admin area and its four sections. A placeholder for now. */
export function AdminArea() {
  return (
    <main>
      <h1>{t("admin.title")}</h1>
      <nav>
        <Link to="/admin/downloads">{t("admin.downloads")}</Link>{" "}
        <Link to="/admin/songs">{t("admin.songs")}</Link>{" "}
        <Link to="/admin/library-problems">{t("admin.libraryProblems")}</Link>{" "}
        <Link to="/admin/profiles">{t("admin.profiles")}</Link>
      </nav>
      <Outlet />
    </main>
  );
}
