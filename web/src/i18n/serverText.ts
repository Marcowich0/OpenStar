// Server texts: the server sends codes plus parameters, never English
// (AGENTS.md, "Codes, not English"). Each generated union of codes gets one
// renderer here, built with `byCode` from one handler per code. The handler
// object must name every code of the union, so a code added on the Rust side
// fails `tsc` here until it has a catalogue string.

import type { ApiError } from "../generated/ApiError";
import type { FileProblem } from "../generated/FileProblem";
import type { LibraryReadOnly } from "../generated/LibraryReadOnly";
import type { LineUpWarning } from "../generated/LineUpWarning";
import type { PartyMemberId } from "../generated/PartyMemberId";
import type { PartyEvent } from "../generated/PartyEvent";
import type { ProblemReason } from "../generated/ProblemReason";
import type { TxtRejection } from "../generated/TxtRejection";
import type { TxtWarning } from "../generated/TxtWarning";
import type { UserMessage } from "../generated/UserMessage";
import { colourName } from "./colourNames";
import { difficultyName, voiceNumber } from "./seatNames";
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
  joinCodeWrong: () => t("userMessage.joinCodeWrong"),
  partyFull: () => t("userMessage.partyFull"),
  notInParty: () => t("userMessage.notInParty"),
  nameTakenTonight: () => t("userMessage.nameTakenTonight"),
  colourTaken: () => t("userMessage.colourTaken"),
  memberNotFound: () => t("userMessage.memberNotFound"),
  jobCancelled: () => t("userMessage.jobCancelled"),
  jobInterrupted: () => t("userMessage.jobInterrupted"),
  toolNotFound: ({ params }) => t("userMessage.toolNotFound", params),
  toolFailed: ({ params: { tool, exitCode } }) =>
    exitCode === null
      ? t("userMessage.toolStopped", { tool })
      : t("userMessage.toolFailed", { tool, exitCode }),
  songNotInLibrary: () => t("userMessage.songNotInLibrary"),
  songPreparing: () => t("userMessage.songPreparing"),
  requestNotFound: () => t("userMessage.requestNotFound"),
  requestCannotMove: () => t("userMessage.requestCannotMove"),
  tooManyPlayers: ({ params }) => t("userMessage.tooManyPlayers", params),
  playerNotInParty: () => t("userMessage.playerNotInParty"),
  playerTwice: () => t("userMessage.playerTwice"),
  memberSinging: () => t("userMessage.memberSinging"),
  profileSinging: () => t("userMessage.profileSinging"),
  useLeaveParty: () => t("userMessage.useLeaveParty"),
  lineUpNotWaiting: () => t("userMessage.lineUpNotWaiting"),
  seatNotFound: () => t("userMessage.seatNotFound"),
  micInUse: () => t("userMessage.micInUse"),
  micNotAvailable: () => t("userMessage.micNotAvailable"),
  localMicNotFound: () => t("userMessage.localMicNotFound"),
  channelAlreadyLocalMic: () => t("userMessage.channelAlreadyLocalMic"),
  notADuet: () => t("userMessage.notADuet"),
  lineUpNotReady: () => t("userMessage.lineUpNotReady"),
  noStage: () => t("userMessage.noStage"),
  noSongPlaying: () => t("userMessage.noSongPlaying"),
  requestPlaying: () => t("userMessage.requestPlaying"),
  difficultyLocked: () => t("userMessage.difficultyLocked"),
  noResults: () => t("userMessage.noResults"),
  notABridge: () => t("userMessage.notABridge"),
  bridgeRequestNotFound: () => t("userMessage.bridgeRequestNotFound"),
  bridgeNotFound: () => t("userMessage.bridgeNotFound"),
  adminPinWait: ({ params: { secondsLeft } }) =>
    secondsLeft < 60
      ? t("userMessage.adminPinWaitSeconds", { count: secondsLeft })
      : t("userMessage.adminPinWaitMinutes", {
          count: Math.ceil(secondsLeft / 60),
        }),
  usdbCredentialsMissing: () => t("userMessage.usdbCredentialsMissing"),
  usdbLoginFailed: () => t("userMessage.usdbLoginFailed"),
  usdbNotLoggedIn: () => t("userMessage.usdbNotLoggedIn"),
  usdbUnreachable: () => t("userMessage.usdbUnreachable"),
  usdbGaveUp: ({ params }) => t("userMessage.usdbGaveUp", params),
  usdbUnexpectedStatus: ({ params }) =>
    t("userMessage.usdbUnexpectedStatus", params),
  usdbSongInLibrary: () => t("userMessage.usdbSongInLibrary"),
  usdbNoSongText: () => t("userMessage.usdbNoSongText"),
  usdbTextRejected: ({ params }) =>
    t("userMessage.usdbTextRejected", {
      reason: txtRejectionText(params.rejection),
    }),
  videoDownloadFailed: () => t("userMessage.videoDownloadFailed"),
  pitchTrackFailed: () => t("userMessage.pitchTrackFailed"),
  songFileChanged: () => t("userMessage.songFileChanged"),
  songPlaying: () => t("userMessage.songPlaying"),
  songStartedSinceOpened: () => t("userMessage.songStartedSinceOpened"),
  noOriginal: () => t("userMessage.noOriginal"),
  songFolderShared: ({ params }) =>
    t("userMessage.songFolderShared", { otherTxt: params.otherTxt }),
  songInLibraryRoot: () => t("userMessage.songInLibraryRoot"),
  notInTrash: () => t("userMessage.notInTrash"),
  restoreFolderExists: ({ params }) =>
    t("userMessage.restoreFolderExists", { path: params.path }),
  notWhileSongPlays: () => t("userMessage.notWhileSongPlays"),
  avSyncNotRunning: () => t("userMessage.avSyncNotRunning"),
  avSyncRunning: () => t("userMessage.avSyncRunning"),
  calibrationRunning: () => t("userMessage.calibrationRunning"),
  calibrationNotRunning: () => t("userMessage.calibrationNotRunning"),
  noMicsChosen: () => t("userMessage.noMicsChosen"),
  noMicReady: () => t("userMessage.noMicReady"),
  notInCalibration: () => t("userMessage.notInCalibration"),
});

/** An accepted change to the Party, as a toast. */
export const partyEventText = byCode<PartyEvent>({
  partyStarted: ({ params }) => t("partyEvent.partyStarted", params),
  memberJoined: ({ params }) =>
    t("partyEvent.memberJoined", {
      name: params.name,
      colour: colourName(params.colour),
    }),
  phoneJoined: ({ params }) =>
    t("partyEvent.phoneJoined", { name: params.name }),
  memberChanged: ({ params }) =>
    t("partyEvent.memberChanged", { name: params.name }),
  requestAdded: ({ params }) =>
    t("partyEvent.requestAdded", { song: params.title }),
  requestMovedUp: ({ params }) =>
    t("partyEvent.requestMovedUp", { song: params.title }),
  requestMovedDown: ({ params }) =>
    t("partyEvent.requestMovedDown", { song: params.title }),
  requestPlayNext: ({ params }) =>
    t("partyEvent.requestPlayNext", { song: params.title }),
  requestRemoved: ({ params }) =>
    t("partyEvent.requestRemoved", { song: params.title }),
  requestedPlayersChanged: ({ params }) =>
    t("partyEvent.requestedPlayersChanged", { song: params.title }),
  requestDroppedSongGone: ({ params }) =>
    t("toast.requestDroppedSongGone", { song: params.title }),
  memberLeft: ({ params }) =>
    t("toast.memberLeft", {
      actor: params.name,
      colour: colourName(params.colour),
    }),
  profileDeleted: ({ params }) =>
    t("toast.profileDeleted", {
      name: params.name,
      colour: colourName(params.colour),
    }),
  micBlocked: ({ params }) => t("partyEvent.micBlocked", { name: params.name }),
  micOpened: ({ params }) => t("partyEvent.micOpened", { name: params.name }),
  lineUpChanged: () => t("partyEvent.lineUpChanged"),
  localMicsChanged: () => t("partyEvent.localMicsChanged"),
  calibrationChanged: () => t("partyEvent.calibrationChanged"),
  seatMoved: ({ params }) => t("partyEvent.seatMoved", { name: params.name }),
  seatVoice: ({ params }) =>
    t("partyEvent.seatVoice", {
      name: params.name,
      voice: voiceNumber(params.voice),
    }),
  seatDifficulty: ({ params }) =>
    t("partyEvent.seatDifficulty", {
      name: params.name,
      difficulty: difficultyName(params.difficulty),
    }),
  nextDifficulty: ({ params }) =>
    t("partyEvent.nextDifficulty", {
      name: params.name,
      difficulty: difficultyName(params.difficulty),
    }),
  songStarted: ({ params }) =>
    t("partyEvent.songStarted", { song: params.title }),
  songPaused: ({ params }) =>
    t("partyEvent.songPaused", { song: params.title }),
  songResumed: ({ params }) =>
    t("partyEvent.songResumed", { song: params.title }),
  songRestarted: ({ params }) =>
    t("partyEvent.songRestarted", { song: params.title }),
  songEnded: ({ params }) => t("partyEvent.songEnded", { song: params.title }),
  songSkipped: ({ params }) =>
    t("partyEvent.songSkipped", { song: params.title }),
  resultsShown: ({ params }) =>
    t("partyEvent.resultsShown", { song: params.title }),
  resultsClosed: () => t("partyEvent.resultsClosed"),
  songAborted: ({ params }) =>
    t("partyEvent.songAborted", { song: params.title }),
  autoFitAccepted: ({ params }) =>
    t("partyEvent.autoFitAccepted", { song: params.title }),
});

/**
 * A Line-up warning. The server names the seat's Party member by id;
 * `nameOf` gives that member's name (from the snapshot or the Profiles).
 */
export function lineUpWarningText(
  warning: LineUpWarning,
  nameOf: (memberId: PartyMemberId) => string,
): string {
  return byCode<LineUpWarning>({
    noMic: ({ params }) =>
      t("lineUpWarning.noMic", { name: nameOf(params.memberId) }),
    micBlocked: ({ params }) =>
      t("lineUpWarning.micBlocked", { name: nameOf(params.memberId) }),
    duetNeedsVoice: ({ params }) =>
      t("lineUpWarning.duetNeedsVoice", {
        voice: voiceNumber(params.voice),
      }),
    notCalibrated: () => t("lineUpWarning.notCalibrated"),
  })(warning);
}

/** Why an HTTP request was refused. */
export const apiErrorText = byCode<ApiError>({
  wrongPin: () => t("apiError.wrongPin"),
  unlockRequired: () => t("apiError.unlockRequired"),
  libraryReadOnly: () => t("apiError.libraryReadOnly"),
  stagePinRequired: () => t("apiError.stagePinRequired"),
});

const API_ERROR_CODES = {
  wrongPin: true,
  unlockRequired: true,
  libraryReadOnly: true,
  stagePinRequired: true,
} as const satisfies Record<ApiError["code"], true>;

/** Why an HTTP request was refused, whichever kind of code it carries. */
export function refusalText(refusal: ApiError | UserMessage): string {
  return Object.hasOwn(API_ERROR_CODES, refusal.code)
    ? apiErrorText(refusal as ApiError)
    : userMessageText(refusal as UserMessage);
}

/** Why the Library is read-only. */
export const libraryReadOnlyText = byCode<LibraryReadOnly>({
  songsFolderNotWritable: ({ songsDir }) =>
    t("libraryReadOnly.songsFolderNotWritable", { songsDir }),
  songsFolderMissing: ({ songsDir }) =>
    t("libraryReadOnly.songsFolderMissing", { songsDir }),
});

const txtRejectionHandlers: CodeHandlers<TxtRejection> = {
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
};

/** Why a `.txt` cannot be played (a Library problem). */
export const txtRejectionText = byCode<TxtRejection>(txtRejectionHandlers);

const fileProblemHandlers: CodeHandlers<FileProblem> = {
  missingAudioReference: () => t("fileProblem.missingAudioReference"),
  audioNotFound: ({ header, reference }) =>
    t("fileProblem.audioNotFound", { header, reference }),
  mediaNotFound: ({ header, reference }) =>
    t("fileProblem.mediaNotFound", { header, reference }),
  unreadableFile: () => t("fileProblem.unreadableFile"),
  unreadableMetadata: () => t("fileProblem.unreadableMetadata"),
  audioNotConverted: ({ file }) => t("fileProblem.audioNotConverted", { file }),
  videoNotConverted: ({ file }) => t("fileProblem.videoNotConverted", { file }),
  hiddenDuplicate: ({ preferred }) =>
    t("fileProblem.hiddenDuplicate", { preferred }),
};

/** Something wrong with the files a `.txt` names (a Library problem). */
export const fileProblemText = byCode<FileProblem>(fileProblemHandlers);

const txtWarningHandlers: CodeHandlers<TxtWarning> = {
  duplicateHeader: ({ line, header }) =>
    t("txtWarning.duplicateHeader", { line, header }),
  invalidNumber: ({ line, header }) =>
    t("txtWarning.invalidNumber", { line, header }),
  zeroLengthNote: ({ line }) => t("txtWarning.zeroLengthNote", { line }),
  overlappingNotes: ({ line, earlierLine }) =>
    t("txtWarning.overlappingNotes", { line, earlierLine }),
  unknownBodyLine: ({ line }) => t("txtWarning.unknownBodyLine", { line }),
};

/** Something wrong with a `.txt` that still lets the Song play. */
export const txtWarningText = byCode<TxtWarning>(txtWarningHandlers);

/**
 * Why a file is a Library problem: any rejection, warning or file problem.
 * The three groups' codes never overlap, so one handler per code covers it.
 */
export const problemReasonText = byCode<ProblemReason>({
  ...txtRejectionHandlers,
  ...txtWarningHandlers,
  ...fileProblemHandlers,
});
