// Delete a Song (v1 spec #46, "Deleting, trash and restore"): its whole
// folder moves to the trash in `/appdata`. It needs an Unlock and writes the
// Library, so it goes through `useGuardedAction`, confirmed by a press and
// hold. The row goes with the `library` notice; a refusal (the Song plays,
// its folder holds another `.txt`, its `.txt` sits in the Library root)
// shows why under the button, and nothing was moved.

import { useState } from "react";

import { ApiFailure, api } from "../api/api";
import type { SongSummary } from "../generated/SongSummary";
import { useGuardedAction } from "../guarded/useGuardedAction";
import { refusalText } from "../i18n/serverText";
import { t } from "../i18n/t";
import { HoldButton } from "../ui/HoldButton";

export function DeleteSong({ song }: { song: SongSummary }) {
  const [failure, setFailure] = useState<string | null>(null);
  const remove = useGuardedAction(
    () => api("DELETE /api/songs/{id}", { params: { id: String(song.id) } }),
    { writesLibrary: true },
  );

  function onHold() {
    setFailure(null);
    remove.run().catch((error: unknown) => {
      setFailure(failureText(error));
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <HoldButton
        fill="red"
        size="small"
        aria-label={t("admin.songs.delete", { title: song.title })}
        onHold={onHold}
        className="w-36 shrink-0"
      >
        {t("admin.songs.deleteShort")}
      </HoldButton>
      {failure === null ? null : (
        <p role="alert" className="max-w-72 text-right font-semibold text-red">
          {failure}
        </p>
      )}
      {remove.dialog}
    </div>
  );
}

function failureText(error: unknown): string {
  if (error instanceof ApiFailure && error.failure.kind === "refused")
    return refusalText(error.failure.error);
  return t("admin.songs.deleteFailed");
}
