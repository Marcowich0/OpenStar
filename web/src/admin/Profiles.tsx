import { t } from "../i18n/t";
import { AdminSection } from "./AdminSection";

/** The Admin area's Profiles section. #48 fills it: deleting a Profile (guarded, press and hold). */
export function Profiles() {
  return (
    <AdminSection title={t("admin.profiles")}>
      {t("admin.profiles.placeholder")}
    </AdminSection>
  );
}
