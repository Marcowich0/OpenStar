import { t } from "../i18n/t";
import { AdminSection } from "./AdminSection";

/**
 * The Admin area's Library problems section. #46 fills it with the list and
 * Rescan (neither guarded); `fileProblemText` and `txtRejectionText` in
 * `i18n/serverText.ts` render the problems.
 */
export function LibraryProblems() {
  return (
    <AdminSection title={t("admin.libraryProblems")}>
      {t("admin.libraryProblems.placeholder")}
    </AdminSection>
  );
}
