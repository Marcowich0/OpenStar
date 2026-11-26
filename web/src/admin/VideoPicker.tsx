// The video picker (v1 spec #47, #194): tapping a USDB result opens a sheet
// listing the videos the song's Download can take its audio and video from,
// in the server's order (the text's `#VIDEO` tags, then comment links, then
// yt-dlp search hits). Each shows its thumbnail, title and duration next to
// the Song's length; a search hit's details come with the list, the others
// are read one by one (the server runs those lookups one at a time). The
// first candidate is preselected. Opening the picker is free; the Download
// button starts the Download through `onDownload` (guarded, #195), and shows
// why it was refused. On a read-only Library it is disabled, with the notice.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from "react-aria-components";

import { ApiFailure } from "../api/api";
import { LibraryReadOnlyNotice } from "../guarded/LibraryReadOnlyNotice";
import { videoCandidatesQuery, videoDetailsQuery } from "../api/queries";
import type { UsdbSong } from "../generated/UsdbSong";
import type { VideoCandidate } from "../generated/VideoCandidate";
import type { VideoSource } from "../generated/VideoSource";
import { userMessageText } from "../i18n/serverText";
import { type MessageKey, t } from "../i18n/t";
import { songLength } from "../phone/songs/SongTags";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";

export interface VideoPickerProps {
  song: UsdbSong;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Starts the Download from the chosen video; until it is given, the
   * Download button is disabled. A rejection is shown as the refusal. */
  onDownload?: (url: string) => Promise<void>;
  /** The Download cannot start (the Library is read-only). */
  isDownloadDisabled?: boolean;
}

const SOURCE_TEXT: Record<VideoSource, MessageKey> = {
  videoTag: "admin.downloads.picker.source.videoTag",
  comment: "admin.downloads.picker.source.comment",
  search: "admin.downloads.picker.source.search",
};

export function VideoPicker({
  song,
  isOpen,
  onOpenChange,
  onDownload,
  isDownloadDisabled = false,
}: VideoPickerProps) {
  return (
    <Sheet
      label={t("admin.downloads.picker", { title: song.title })}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      {isOpen ? (
        <PickerBody
          song={song}
          onDownload={isDownloadDisabled ? undefined : onDownload}
        />
      ) : null}
    </Sheet>
  );
}

function PickerBody({
  song,
  onDownload,
}: {
  song: UsdbSong;
  onDownload: ((url: string) => Promise<void>) | undefined;
}) {
  const found = useQuery(videoCandidatesQuery(song.usdbId));
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // `null` until the admin picks one: the first candidate is preselected.
  const [picked, setPicked] = useState<string | null>(null);
  const candidates = found.data?.candidates ?? [];
  const chosen = picked ?? candidates[0]?.url ?? null;

  return (
    <div className="flex flex-col gap-3">
      <header className="flex min-w-0 flex-col">
        <h2 className="truncate text-2xl font-semibold">{song.title}</h2>
        <span className="truncate text-ink-2">{song.artist}</span>
        {found.data ? (
          <span className="text-base font-semibold">
            {found.data.songLengthSeconds === null
              ? t("admin.downloads.picker.songLengthUnknown")
              : t("admin.downloads.picker.songLength", {
                  length: songLength(found.data.songLengthSeconds),
                })}
          </span>
        ) : null}
      </header>
      {found.isError ? (
        <p role="alert" className="rounded-card-sm bg-white p-3">
          {failureText(found.error)}
        </p>
      ) : !found.data ? (
        <p role="status" className="py-4 text-center">
          {t("admin.downloads.picker.loading")}
        </p>
      ) : (
        <>
          {found.data.searchFailure ? (
            <p role="status" className="rounded-card-sm bg-white p-3">
              {t("admin.downloads.picker.searchFailed")}
            </p>
          ) : null}
          {candidates.length === 0 ? (
            <p className="py-4 text-center">
              {t("admin.downloads.picker.none")}
            </p>
          ) : (
            <RadioGroup
              value={chosen}
              onChange={setPicked}
              className="flex flex-col gap-2"
            >
              <Label className="sr-only">
                {t("admin.downloads.picker.candidates")}
              </Label>
              {candidates.map((candidate) => (
                <CandidateOption key={candidate.url} candidate={candidate} />
              ))}
            </RadioGroup>
          )}
          <LibraryReadOnlyNotice />
          {refusal !== null ? (
            <p role="alert" className="rounded-card-sm bg-white p-3">
              {refusal}
            </p>
          ) : null}
          <Button
            fill="green"
            isDisabled={chosen === null || onDownload === undefined || starting}
            onPress={() => {
              if (chosen === null || onDownload === undefined) return;
              setStarting(true);
              setRefusal(null);
              onDownload(chosen).then(
                () => {
                  setStarting(false);
                },
                (error: unknown) => {
                  setStarting(false);
                  setRefusal(downloadFailureText(error));
                },
              );
            }}
            className="w-full"
          >
            {t("admin.downloads.picker.download")}
          </Button>
        </>
      )}
    </div>
  );
}

function CandidateOption({ candidate }: { candidate: VideoCandidate }) {
  const lookup = useQuery({
    ...videoDetailsQuery(candidate.url),
    enabled: candidate.details === null,
  });
  const details = candidate.details ?? lookup.data ?? null;
  const unavailable = candidate.details === null && lookup.isError;

  return (
    <RadioField value={candidate.url}>
      <RadioButton
        className={[
          "flex min-w-0 cursor-pointer items-center gap-3 rounded-card-sm p-2 outline-none",
          "data-focus-visible:outline-6 data-focus-visible:outline-yellow",
          "data-selected:bg-white data-selected:shadow-ledge-sm",
        ].join(" ")}
      >
        <span className="aspect-video w-24 shrink-0 overflow-hidden rounded-card-sm bg-ledge">
          {details?.thumbnail ? (
            <img
              src={details.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-full object-cover"
            />
          ) : null}
        </span>
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate text-lg leading-tight font-semibold">
            {details?.title ||
              (unavailable
                ? t("admin.downloads.picker.unavailable")
                : t("admin.downloads.picker.reading"))}
          </span>
          <span className="truncate text-sm text-ink-2">{candidate.url}</span>
          <span className="flex flex-wrap gap-x-3 text-sm text-ink-2">
            <span>{t(SOURCE_TEXT[candidate.source])}</span>
            {details ? (
              <span className="font-semibold text-ink">
                {details.durationSeconds === null
                  ? t("admin.downloads.picker.durationUnknown")
                  : songLength(details.durationSeconds)}
              </span>
            ) : null}
          </span>
        </span>
      </RadioButton>
    </RadioField>
  );
}

function downloadFailureText(error: unknown): string {
  return error instanceof ApiFailure && error.failure.kind === "refused"
    ? userMessageText(error.failure.error)
    : t("admin.downloads.picker.downloadFailed");
}

function failureText(error: Error): string {
  return error instanceof ApiFailure && error.failure.kind === "refused"
    ? userMessageText(error.failure.error)
    : t("admin.downloads.picker.failed");
}
