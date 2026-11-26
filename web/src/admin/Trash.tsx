// The trash, in the Admin area's Songs section (v1 spec #46, "Deleting,
// trash and restore"): every trashed Song folder with its original path and
// when it was deleted. Restoring one needs an Unlock and writes the Library,
// so it goes through `useGuardedAction`, confirmed by a press and hold. The
// row goes with the `library` notice; a refusal (a folder of that name is in
// the Library now) shows why under the button, and nothing was moved. The
// server purges a folder 30 days after its delete.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ApiFailure, api } from "../api/api";
import { trashQuery } from "../api/queries";
import type { TrashedSong } from "../generated/TrashedSong";
import { useGuardedAction } from "../guarded/useGuardedAction";
import { refusalText } from "../i18n/serverText";
import { t } from "../i18n/t";
import { HoldButton } from "../ui/HoldButton";

// The catalogue's language, as `t` formats numbers in it.
const DELETED_AT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function Trash() {
  const list = useQuery(trashQuery);

  return (
    <section
      aria-labelledby="admin-songs-trash"
      className="flex flex-col gap-3"
    >
      <h3
        id="admin-songs-trash"
        className="text-xl leading-tight font-semibold text-ink"
      >
        {t("admin.songs.trash")}
      </h3>
      <p className="text-sm text-ink-2">{t("admin.songs.trash.kept")}</p>
      {list.data ? (
        list.data.songs.length === 0 ? (
          <p className="py-2">{t("admin.songs.trash.empty")}</p>
        ) : (
          <ul
            aria-label={t("admin.songs.trash.list")}
            className="flex flex-col gap-3"
          >
            {list.data.songs.map((song) => (
              <TrashRow key={song.id} song={song} />
            ))}
          </ul>
        )
      ) : (
        <p role="status" className="py-2">
          {t(
            list.isError
              ? "admin.songs.trash.failed"
              : "admin.songs.trash.loading",
          )}
        </p>
      )}
    </section>
  );
}

function TrashRow({ song }: { song: TrashedSong }) {
  const [failure, setFailure] = useState<string | null>(null);
  const restore = useGuardedAction(
    () =>
      api("POST /api/library/trash/{id}/restore", {
        params: { id: String(song.id) },
      }),
    { writesLibrary: true },
  );

  function onHold() {
    setFailure(null);
    restore.run().catch((error: unknown) => {
      setFailure(failureText(error));
    });
  }

  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3">
      <div className="flex min-w-0 grow basis-0 flex-col gap-0.5">
        <span className="text-lg leading-tight font-semibold break-words text-ink">
          {song.originalPath}
        </span>
        <span className="text-sm text-ink-2">
          {t("admin.songs.trash.deleted", {
            when: DELETED_AT.format(song.deletedMs),
          })}
        </span>
      </div>
      <div className="flex max-w-full flex-col items-end gap-1">
        <HoldButton
          fill="ink"
          size="small"
          aria-label={t("admin.songs.trash.restore", {
            path: song.originalPath,
          })}
          onHold={onHold}
          className="w-36 shrink-0"
        >
          {t("admin.songs.trash.restoreShort")}
        </HoldButton>
        {failure === null ? null : (
          <p
            role="alert"
            className="max-w-72 text-right font-semibold text-red"
          >
            {failure}
          </p>
        )}
        {restore.dialog}
      </div>
    </li>
  );
}

function failureText(error: unknown): string {
  if (error instanceof ApiFailure && error.failure.kind === "refused")
    return refusalText(error.failure.error);
  return t("admin.songs.trash.restoreFailed");
}
