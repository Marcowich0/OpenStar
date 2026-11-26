// Restore Original (v1 spec #46): on a Song that OpenStar has edited, puts
// the Original (`<name>.txt.orig`) back over its `.txt` and deletes it. It
// needs an Unlock and writes the Library, so it goes through `GuardedButton`.
// The row loses the button when the `library` notice refreshes the
// Originals.

import { useState } from "react";

import { ApiFailure, api } from "../api/api";
import type { SongId } from "../generated/SongId";
import { GuardedButton } from "../guarded/GuardedButton";
import { refusalText } from "../i18n/serverText";
import { t } from "../i18n/t";

export function RestoreOriginal({ songId }: { songId: SongId }) {
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <GuardedButton
        writesLibrary
        action={() => {
          setFailure(null);
          return api("POST /api/songs/{id}/restore-original", {
            params: { id: String(songId) },
          });
        }}
        onFailure={(error) => {
          setFailure(failureText(error));
        }}
      >
        {t("admin.songs.restoreOriginal")}
      </GuardedButton>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-ink-2">
          {failure}
        </p>
      )}
    </div>
  );
}

function failureText(error: unknown): string {
  if (error instanceof ApiFailure && error.failure.kind === "refused")
    return refusalText(error.failure.error);
  return t("admin.songs.restoreOriginal.failed");
}
