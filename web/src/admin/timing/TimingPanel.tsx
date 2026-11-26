// The Timing editor's side panel (v1 spec #57): the typed `#GAP` and `#BPM`,
// the "notes on the singing" share, the edit list with Undo, Redo and Back
// to the file, and the save preview with Save. The preview comes from the
// server, computed from the current operations by the patcher that writes;
// the browser never writes `.txt` bytes.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Button as AriaButton,
  Input,
  Label,
  Meter,
  TextField,
} from "react-aria-components";

import { ApiFailure, api } from "../../api/api";
import { songsKey } from "../../api/queries";
import type { ChangedLine } from "../../generated/ChangedLine";
import type { SongId } from "../../generated/SongId";
import type { TimingOperation } from "../../generated/TimingOperation";
import type { TimingPreview } from "../../generated/TimingPreview";
import { LibraryReadOnlyNotice } from "../../guarded/LibraryReadOnlyNotice";
import { useGuardedAction } from "../../guarded/useGuardedAction";
import { refusalText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import { describeEdit } from "../../timing/describeEdit";
import type { EditListEntry } from "../../timing/timingModel";
import { Button } from "../../ui/Button";

/** A typed number: `,` or `.` as the decimal mark; anything else is `NaN`. */
export function parseTyped(text: string): number {
  const trimmed = text.trim().replace(",", ".");
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

/**
 * One typed header value. It commits on Enter or when it loses focus, and
 * shows "file: <value>" while the current value differs from the file's.
 */
export function TypedValue({
  label,
  value,
  fileValue,
  onCommit,
}: {
  label: string;
  value: number;
  fileValue: number;
  onCommit: (typed: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    onCommit(parseTyped(draft));
  };
  return (
    <TextField
      value={draft ?? String(value)}
      onChange={setDraft}
      onBlur={commit}
      className="flex flex-col gap-1"
    >
      <Label className="text-lg font-semibold">{label}</Label>
      <Input
        inputMode="decimal"
        autoComplete="off"
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
        className="h-11 rounded-full bg-white px-4 text-xl tabular-nums text-ink ring-2 ring-ledge outline-none focus-visible:ring-ink"
      />
      {value === fileValue ? null : (
        <span className="text-sm text-ink-2 tabular-nums">
          {t("timing.panel.fileValue", { value: fileValue })}
        </span>
      )}
    </TextField>
  );
}

/** The share of Note time on the singing, with the file's own once they differ. */
export function ShareMeter({
  share,
  fileShare,
  pending,
}: {
  share: number | null;
  fileShare: number | null;
  pending: boolean;
}) {
  const percent = share === null ? null : Math.round(share * 100);
  const filePercent = fileShare === null ? null : Math.round(fileShare * 100);
  return (
    <div className="flex flex-col gap-2">
      {pending || percent === null ? (
        <div className="flex flex-col gap-2">
          <span className="text-lg font-semibold">
            {t("timing.view.share")}
          </span>
          <span className="text-ink-2">
            {t(pending ? "timing.view.sharePending" : "timing.view.shareNone")}
          </span>
        </div>
      ) : (
        <Meter value={percent} className="flex flex-col gap-2">
          <Label className="text-lg font-semibold">
            {t("timing.view.share")}
          </Label>
          <div className="flex items-center gap-3">
            <div className="h-3.5 grow overflow-hidden rounded-full bg-passed ring-2 ring-ink">
              <div
                className="h-full rounded-full bg-green transition-[width]"
                style={{ width: `${String(percent)}%` }}
              />
            </div>
            <span className="min-w-14 text-right text-2xl font-bold tabular-nums">
              {t("timing.view.sharePercent", { percent })}
            </span>
          </div>
          {filePercent === null || filePercent === percent ? null : (
            <span className="text-sm text-ink-2 tabular-nums">
              {t("timing.panel.fileShare", { percent: filePercent })}
            </span>
          )}
        </Meter>
      )}
      <p className="text-sm text-ink-2">{t("timing.view.shareWhat")}</p>
    </div>
  );
}

const SMALL_BUTTON =
  "rounded-full bg-white px-3.5 py-1.5 text-base font-semibold text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow disabled:opacity-40";

/** The edit list, each edit in words; undone ones struck through. */
export function EditList({
  entries,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onBackToTheFile,
}: {
  entries: readonly EditListEntry[];
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onBackToTheFile: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-lg font-semibold">{t("timing.panel.edits")}</span>
      <ol
        aria-label={t("timing.panel.edits")}
        className="flex max-h-48 flex-col gap-1 overflow-y-auto text-base"
      >
        {entries.map((entry, i) => (
          // The list only grows or shrinks at its end, so the index is stable.
          <li key={i} className={entry.undone ? "text-mute" : ""}>
            {entry.undone ? (
              <del>{describeEdit(entry.description)}</del>
            ) : (
              describeEdit(entry.description)
            )}
          </li>
        ))}
      </ol>
      {entries.length === 0 ? (
        <p className="text-ink-2">{t("timing.panel.noEdits")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <AriaButton
          className={SMALL_BUTTON}
          isDisabled={!canUndo}
          onPress={onUndo}
        >
          {t("timing.panel.undo")}
        </AriaButton>
        <AriaButton
          className={SMALL_BUTTON}
          isDisabled={!canRedo}
          onPress={onRedo}
        >
          {t("timing.panel.redo")}
        </AriaButton>
        <AriaButton
          className={SMALL_BUTTON}
          isDisabled={!canUndo && !canRedo}
          onPress={onBackToTheFile}
        >
          {t("timing.panel.backToTheFile")}
        </AriaButton>
      </div>
      <p className="text-sm text-ink-2">{t("timing.panel.keys")}</p>
    </div>
  );
}

/** `POST /api/songs/{id}/timing/preview` for `operations`, refreshed by the `library` notice. */
function usePreview(song: SongId, operations: readonly TimingOperation[]) {
  return useQuery({
    queryKey: [...songsKey, song, "timingPreview", operations],
    queryFn: ({ signal }) =>
      api("POST /api/songs/{id}/timing/preview", {
        params: { id: String(song) },
        body: { operations: [...operations] },
        signal,
      }),
    enabled: operations.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

function failureText(error: unknown, fallback: "preview" | "save"): string {
  if (error instanceof ApiFailure && error.failure.kind === "refused")
    return refusalText(error.failure.error);
  return t(
    fallback === "preview"
      ? "timing.panel.previewFailed"
      : "timing.panel.saveFailed",
  );
}

/**
 * The save preview and Save. Save is a guarded action that writes the
 * Library; it sends the current operations against the file the preview
 * was computed from, and `onSaved` gets what was written.
 */
export function SaveSection({
  song,
  operations,
  onSaved,
  playing = false,
  openedAtMs,
}: {
  song: SongId;
  operations: readonly TimingOperation[];
  onSaved: (written: TimingPreview) => void;
  /** The Song plays on the Stage now: Save is disabled (#225). */
  playing?: boolean;
  /** The opened detail's `loadedAtMs`, sent with the save (#225). */
  openedAtMs?: number | undefined;
}) {
  const preview = usePreview(song, operations);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [savedFor, setSavedFor] = useState(operations);
  // A new edit clears the last save's outcome.
  if (savedFor !== operations) {
    setSavedFor(operations);
    if (operations.length > 0) {
      setSaved(null);
      setFailure(null);
    }
  }

  const current =
    operations.length > 0 && preview.data && !preview.isPlaceholderData
      ? preview.data
      : null;
  const save = useGuardedAction(
    () => {
      if (!current) return Promise.reject(new Error("no preview to save"));
      return api("POST /api/songs/{id}/timing", {
        params: { id: String(song) },
        body: {
          base: current.base,
          operations: [...operations],
          ...(openedAtMs === undefined ? {} : { openedAtMs }),
        },
      });
    },
    { writesLibrary: true },
  );

  const changed: readonly ChangedLine[] =
    operations.length === 0 ? [] : (preview.data?.changed ?? []);
  const loading = operations.length > 0 && !current && !preview.isError;
  const canSave =
    current !== null &&
    current.changed.length > 0 &&
    !playing &&
    !saving &&
    !save.isDisabled;

  return (
    <section
      aria-label={t("timing.panel.preview")}
      className="flex flex-col gap-3"
    >
      <span className="text-lg font-semibold">{t("timing.panel.preview")}</span>
      {preview.isError && operations.length > 0 ? (
        <p role="alert" className="text-warn-fg">
          {failureText(preview.error, "preview")}
        </p>
      ) : loading ? (
        <p className="text-ink-2">{t("timing.panel.previewLoading")}</p>
      ) : changed.length === 0 ? (
        <p className="text-ink-2">{t("timing.panel.previewNothing")}</p>
      ) : (
        <>
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-ink-2">
                <th className="w-12 font-semibold">
                  {t("timing.panel.previewLine")}
                </th>
                <th className="font-semibold">
                  {t("timing.panel.previewOld")}
                </th>
                <th className="font-semibold">
                  {t("timing.panel.previewNew")}
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {changed.map((c) => (
                <tr key={c.line} className="align-top">
                  <td className="tabular-nums">{c.line}</td>
                  <td className="break-all text-red">
                    {c.old ?? t("timing.panel.previewNoLine")}
                  </td>
                  <td className="break-all text-green">
                    {c.new ?? t("timing.panel.previewNoLine")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-ink-2">
            {t("timing.panel.previewCount", { count: changed.length })}
          </p>
        </>
      )}
      <LibraryReadOnlyNotice />
      <Button
        fill="green"
        isDisabled={!canSave}
        onPress={() => {
          setFailure(null);
          setSaved(null);
          setSaving(true);
          save.run().then(
            (outcome) => {
              setSaving(false);
              if (outcome.kind !== "done") return;
              setSaved(outcome.value.changed.length);
              onSaved(outcome.value);
            },
            (error: unknown) => {
              setSaving(false);
              setFailure(failureText(error, "save"));
            },
          );
        }}
      >
        {t("timing.panel.save")}
      </Button>
      {playing ? (
        <p className="text-sm text-ink-2">{t("song.playingNow.reason")}</p>
      ) : null}
      {save.dialog}
      {failure === null ? null : (
        <p role="alert" className="font-semibold text-warn-fg">
          {failure}
        </p>
      )}
      {saved === null ? null : (
        <p
          role="status"
          aria-label={t("timing.panel.saved")}
          className="font-semibold"
        >
          {t("timing.panel.savedCount", { count: saved })}
        </p>
      )}
    </section>
  );
}
