import { t } from "../i18n/t";
import { AdminSection } from "./AdminSection";

/** The Admin area's Downloads section. #47 fills it: USDB search and the Download jobs. */
export function Downloads() {
  return (
    <AdminSection title={t("admin.downloads")} writesLibrary>
      {t("admin.downloads.placeholder")}
    </AdminSection>
  );
}
