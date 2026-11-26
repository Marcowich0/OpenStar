// Compile-time checks of the server-text mapping. Never run; `tsc` checks
// each `@ts-expect-error`.

import type { PartyEvent } from "../generated/PartyEvent";
import type { ProblemReason } from "../generated/ProblemReason";
import type { UserMessage } from "../generated/UserMessage";
import {
  byCode,
  problemReasonText,
  txtRejectionText,
  type CodeHandlers,
} from "./serverText";
import { t } from "./t";

const handlers: CodeHandlers<UserMessage> = {
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
  toolFailed: ({ params }) =>
    t("userMessage.toolFailed", {
      tool: params.tool,
      exitCode: params.exitCode ?? 0,
    }),
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
  adminPinWait: ({ params }) =>
    t("userMessage.adminPinWaitSeconds", { count: params.secondsLeft }),
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
};

// A code the Rust side adds (here `queueFull`) fails until it is mapped.
type WithNewCode = UserMessage | { code: "queueFull"; params: { max: number } };
// @ts-expect-error: `queueFull` has no handler.
export const unmapped = byCode<WithNewCode>(handlers);

export const mapped = byCode<WithNewCode>({
  ...handlers,
  queueFull: ({ params }) => String(params.max),
});

declare const missingOne: Omit<typeof handlers, "serverError">;
// @ts-expect-error: every code of the union needs a handler.
export const missing = byCode<UserMessage>(missingOne);

export const wrongParam = byCode<PartyEvent>({
  // @ts-expect-error: `partyStarted` has `joinCode`, not `max`.
  partyStarted: ({ params }) => String(params.max),
  memberJoined: ({ params }) => params.name,
  phoneJoined: ({ params }) => params.name,
  memberChanged: ({ params }) => params.name,
  requestAdded: ({ params }) => params.title,
  requestMovedUp: ({ params }) => params.title,
  requestMovedDown: ({ params }) => params.title,
  requestPlayNext: ({ params }) => params.title,
  requestRemoved: ({ params }) => params.title,
  requestedPlayersChanged: ({ params }) => params.title,
  requestDroppedSongGone: ({ params }) => params.title,
  memberLeft: ({ params }) => params.name,
  profileDeleted: ({ params }) => params.name,
  micBlocked: ({ params }) => params.name,
  micOpened: ({ params }) => params.name,
  lineUpChanged: () => "",
  localMicsChanged: () => "",
  seatMoved: ({ params }) => params.name,
  seatVoice: ({ params }) => params.voice,
  seatDifficulty: ({ params }) => params.difficulty,
  nextDifficulty: ({ params }) => params.difficulty,
  songStarted: ({ params }) => params.title,
  songPaused: ({ params }) => params.title,
  songResumed: ({ params }) => params.title,
  songRestarted: ({ params }) => params.title,
  songEnded: ({ params }) => params.title,
  songSkipped: ({ params }) => params.title,
  resultsShown: ({ params }) => params.title,
  resultsClosed: () => "",
  autoFitAccepted: ({ params }) => params.title,
});

// Every Library problem reason renders through one handler per code: a
// handler object for the reason union that leaves a code out fails tsc, so
// a code the server adds without a catalogue text is a type error.
// @ts-expect-error: `videoNotConverted` (a file problem) has no handler.
byCode<ProblemReason>({
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
  duplicateHeader: ({ line, header }) =>
    t("txtWarning.duplicateHeader", { line, header }),
  invalidNumber: ({ line, header }) =>
    t("txtWarning.invalidNumber", { line, header }),
  zeroLengthNote: ({ line }) => t("txtWarning.zeroLengthNote", { line }),
  overlappingNotes: ({ line, earlierLine }) =>
    t("txtWarning.overlappingNotes", { line, earlierLine }),
  unknownBodyLine: ({ line }) => t("txtWarning.unknownBodyLine", { line }),
  missingAudioReference: () => t("fileProblem.missingAudioReference"),
  audioNotFound: ({ header, reference }) =>
    t("fileProblem.audioNotFound", { header, reference }),
  mediaNotFound: ({ header, reference }) =>
    t("fileProblem.mediaNotFound", { header, reference }),
  unreadableFile: () => t("fileProblem.unreadableFile"),
  unreadableMetadata: () => t("fileProblem.unreadableMetadata"),
  audioNotConverted: ({ file }) => t("fileProblem.audioNotConverted", { file }),
  hiddenDuplicate: ({ preferred }) =>
    t("fileProblem.hiddenDuplicate", { preferred }),
});

// The renderer takes any reason, and only a reason.
problemReasonText({ code: "unreadableMetadata" });
problemReasonText({ code: "zeroLengthNote", line: 4 });
// @ts-expect-error: a reason with an unknown code.
problemReasonText({ code: "notAReason" });
// @ts-expect-error: `duplicateHeader` needs its header name.
problemReasonText({ code: "duplicateHeader", line: 2 });
