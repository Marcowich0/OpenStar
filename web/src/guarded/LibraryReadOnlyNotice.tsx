// Why the guarded actions that write the Library are disabled: the
// read-only Library notice (v1 spec #45, #46). Shows nothing while the
// Library can be written.

import { libraryReadOnlyText } from "../i18n/serverText";
import { useLibraryReadOnly } from "./useGuardedAction";

export function LibraryReadOnlyNotice() {
  const readOnly = useLibraryReadOnly();
  if (readOnly === null) return null;
  return (
    <p className="rounded-card-sm bg-warn-bg px-5 py-3 text-lg font-semibold text-warn-fg">
      {libraryReadOnlyText(readOnly)}
    </p>
  );
}
