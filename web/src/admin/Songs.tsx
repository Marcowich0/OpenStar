import { t } from "../i18n/t";
import { AdminSection } from "./AdminSection";

/** The Admin area's Songs section. #46 and #57 fill it: timing, Restore Original, delete and restore. */
export function Songs() {
  return (
    <AdminSection title={t("admin.songs")} writesLibrary>
      {t("admin.songs.placeholder")}
    </AdminSection>
  );
}
