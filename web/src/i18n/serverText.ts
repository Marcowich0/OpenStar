// Server texts: the server sends codes plus parameters, never English
// (AGENTS.md, "Codes, not English"). Each generated union of codes gets one
// renderer here, built with `byCode` from one handler per code. The handler
// object must name every code of the union, so a code added on the Rust side
// fails `tsc` here until it has a catalogue string.

import type { ApiError } from "../generated/ApiError";
import type { LibraryReadOnly } from "../generated/LibraryReadOnly";
import type { PartyEvent } from "../generated/PartyEvent";
import type { TxtRejection } from "../generated/TxtRejection";
import type { TxtWarning } from "../generated/TxtWarning";
import type { UserMessage } from "../generated/UserMessage";
import { t } from "./t";

/** One handler per code of `U`, each given the message narrowed to its code. */
export type CodeHandlers<U extends { code: string }> = {
  [C in U["code"]]: (message: U & { code: C }) => string;
};

/**
 * Builds the renderer of a code union from one handler per code. A missing
 * code, an extra code, or a handler that reads a parameter its code does not
 * have fails `tsc`.
 */
export function byCode<U extends { code: string }>(
  handlers: CodeHandlers<U>,
): (message: U) => string {
  return (message) => {
    const handler = handlers[message.code as U["code"]];
    return handler(message);
  };
}

/** A rejection, error or event the server sent over the WebSocket. */
export const userMessageText = byCode<UserMessage>({
  invalidMessage: () => t("userMessage.invalidMessage"),
  notTheStage: () => t("userMessage.notTheStage"),
  serverError: () => t("userMessage.serverError"),
  profileNameEmpty: () => t("userMessage.profileNameEmpty"),
  profileNameTooLong: ({ params }) =>
    t("userMessage.profileNameTooLong", params),
  profileNameTaken: () => t("userMessage.profileNameTaken"),
  profileNotFound: () => t("userMessage.profileNotFound"),
});

/** An accepted change to the Party, as a toast. */
export const partyEventText = byCode<PartyEvent>({
  partyStarted: ({ params }) => t("partyEvent.partyStarted", params),
});

/** Why an HTTP request was refused. */
export const apiErrorText = byCode<ApiError>({
  wrongPin: () => t("apiError.wrongPin"),
  unlockRequired: () => t("apiError.unlockRequired"),
  libraryReadOnly: () => t("apiError.libraryReadOnly"),
});

/** Why the Library is read-only. */
export const libraryReadOnlyText = byCode<LibraryReadOnly>({
  songsFolderNotWritable: ({ songsDir }) =>
    t("libraryReadOnly.songsFolderNotWritable", { songsDir }),
  songsFolderMissing: ({ songsDir }) =>
    t("libraryReadOnly.songsFolderMissing", { songsDir }),
});

/** Why a `.txt` cannot be played (a Library problem). */
export const txtRejectionText = byCode<TxtRejection>({
  invalidVersion: ({ line }) => t("txtRejection.invalidVersion", { line }),
  unsupportedVersion: ({ line }) =>
    t("txtRejection.unsupportedVersion", { line }),
  relativeMode: ({ line }) => t("txtRejection.relativeMode", { line }),
  missingBpm: () => t("txtRejection.missingBpm"),
  invalidBpm: ({ line }) => t("txtRejection.invalidBpm", { line }),
  missingArtist: () => t("txtRejection.missingArtist"),
  missingTitle: () => t("txtRejection.missingTitle"),
  noNotes: () => t("txtRejection.noNotes"),
  duetVoiceWithoutNotes: ({ voice }) =>
    t("txtRejection.duetVoiceWithoutNotes", { voice }),
  invalidNoteLine: ({ line }) => t("txtRejection.invalidNoteLine", { line }),
  invalidVoice: ({ line }) => t("txtRejection.invalidVoice", { line }),
});

/** Something wrong with a `.txt` that still lets the Song play. */
export const txtWarningText = byCode<TxtWarning>({
  duplicateHeader: ({ line, header }) =>
    t("txtWarning.duplicateHeader", { line, header }),
  invalidNumber: ({ line, header }) =>
    t("txtWarning.invalidNumber", { line, header }),
  zeroLengthNote: ({ line }) => t("txtWarning.zeroLengthNote", { line }),
  overlappingNotes: ({ line, earlierLine }) =>
    t("txtWarning.overlappingNotes", { line, earlierLine }),
  unknownBodyLine: ({ line }) => t("txtWarning.unknownBodyLine", { line }),
});
