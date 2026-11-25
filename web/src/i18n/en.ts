// The English catalogue: every word OpenStar shows. Another language is a
// copy of this file typed as `Catalogue` (from `t.ts`), with each text
// translated; nothing where the strings are used changes. The syntax of an
// entry is described at the top of `t.ts`.
//
// Keys are grouped by where the text appears. Screens add their own keys as
// they are built.

import type { Entry } from "./t";

export const en = {
  // The Phone screens.
  "phone.title": "OpenStar",
  "join.enterCode": "Enter the Join code",
  "join.code": "Join code {code}",

  // The shared input pieces in `ui/`: the hold button and the number pad.
  "hold.hint": "Hold for a moment",
  "numberPad.joinCode": "Join code",
  "numberPad.codeRefused": "That code is not on the Stage",
  "numberPad.adminPin": "Admin PIN",
  "numberPad.pinEntered": {
    one: "{count, number} digit entered",
    other: "{count, number} digits entered",
  },
  "numberPad.delete": "Delete",
  "numberPad.ok": "OK",

  // The walking skeleton's server check (shown on the Phone and the Stage).
  "server.loading": "Asking the server…",
  "server.failed": "The server did not answer",
  "server.version": "Server {version}, schema {schemaVersion, number}",

  // The walking skeleton's view of the Party, until the Stage and Phone
  // screens replace it.
  "live.connecting": "WebSocket: connecting",
  "live.open": "WebSocket: open",
  "live.reconnecting": "WebSocket: reconnecting",
  "live.newParty": "New party",
  "live.stageMoved": "Another browser is the Stage now",

  // The Stage, the Mic bridge page and the Admin area.
  "stage.title": "Stage",
  "stage.sing": "Sing!",
  "stage.start": "Start",
  "stage.end": "End",
  "stage.back": "Back",
  "stage.takeBack": "Make this the Stage again",
  "chip.duet": "Duet",
  "bridge.title": "Mic bridge",
  "admin.title": "Admin",
  "admin.downloads": "Downloads",
  "admin.songs": "Songs",
  "admin.libraryProblems": "Library problems",
  "admin.profiles": "Profiles",

  // The twelve Party colours' display names, keyed by palette key.
  "colour.cherry": "Cherry",
  "colour.sky": "Sky",
  "colour.navy": "Navy",
  "colour.cocoa": "Cocoa",
  "colour.teal": "Teal",
  "colour.lime": "Lime",
  "colour.berry": "Berry",
  "colour.mint": "Mint",
  "colour.bubblegum": "Bubblegum",
  "colour.forest": "Forest",
  "colour.grape": "Grape",
  "colour.tangerine": "Tangerine",

  // Server texts: one key per code the server sends (`serverText.ts`).
  "userMessage.invalidMessage": "The server could not read that message",
  "userMessage.notTheStage": "Only the Stage can do that",
  "userMessage.serverError": "Something went wrong on the server",
  "userMessage.profileNameEmpty": "A Profile needs a name",
  "userMessage.profileNameTooLong":
    "A Profile name can be at most {maxLength, number} characters long",
  "userMessage.profileNameTaken": "A Profile with that name already exists",
  "userMessage.profileNotFound": "That Profile no longer exists",
  "userMessage.joinCodeWrong": "That code is not on the Stage",
  "userMessage.partyFull": "Party is full",
  "userMessage.notInParty": "Join the Party first",
  "userMessage.jobCancelled": "Cancelled",
  "userMessage.jobInterrupted": "A server restart interrupted this",
  "userMessage.toolNotFound": "{tool} is not installed on the server",
  "userMessage.toolFailed": "{tool} failed with exit code {exitCode, number}",
  "userMessage.toolStopped": "{tool} was stopped before it finished",
  "userMessage.songNotInLibrary": "That Song is not in the Library",
  "userMessage.songPreparing":
    "That Song is still being prepared. Try again in a moment",
  "userMessage.requestNotFound": "That Song is no longer in the Queue",
  "userMessage.requestCannotMove": "That Song cannot move there",
  "userMessage.tooManyPlayers": "At most {max, number} Players can sing a Song",
  "userMessage.playerNotInParty": "Someone you picked is not in the Party",
  "userMessage.playerTwice": "Someone is picked twice",

  "apiError.wrongPin": "That is not the Admin PIN",
  "apiError.unlockRequired": "Enter the Admin PIN first",
  "apiError.libraryReadOnly": "The Library is read-only",

  "libraryReadOnly.songsFolderNotWritable":
    "OpenStar cannot write to the songs folder {songsDir}, so the Library is read-only",
  "libraryReadOnly.songsFolderMissing":
    "The songs folder {songsDir} does not exist, so the Library is read-only",

  "txtRejection.invalidVersion":
    "Line {line, number}: the #VERSION is not valid",
  "txtRejection.unsupportedVersion":
    "Line {line, number}: this #VERSION is not supported",
  "txtRejection.relativeMode":
    "Line {line, number}: #RELATIVE files are not supported",
  "txtRejection.missingBpm": "The file has no #BPM",
  "txtRejection.invalidBpm": "Line {line, number}: the #BPM is not valid",
  "txtRejection.missingArtist": "The file has no #ARTIST",
  "txtRejection.missingTitle": "The file has no #TITLE",
  "txtRejection.noNotes": "The file has no Notes",
  "txtRejection.duetVoiceWithoutNotes":
    "Voice {voice, number} of the duet has no Notes",
  "txtRejection.invalidNoteLine": "Line {line, number}: the Note is not valid",
  "txtRejection.invalidVoice": "Line {line, number}: the Voice is not valid",

  "txtWarning.duplicateHeader":
    "Line {line, number}: #{header} appears more than once",
  "txtWarning.invalidNumber":
    "Line {line, number}: #{header} is not a valid number",
  "txtWarning.zeroLengthNote": "Line {line, number}: the Note has no length",
  "txtWarning.overlappingNotes":
    "Line {line, number}: the Note overlaps the one on line {earlierLine, number}",
  "txtWarning.unknownBodyLine": "Line {line, number} is not understood",

  // Toasts: structured events from the server, rendered on the Stage and Phones.
  "partyEvent.partyStarted": "New party started, Join code {joinCode}",
  "partyEvent.memberJoined": "{name} joined the Party in {colour}",
  "partyEvent.phoneJoined": "{name} joined on another Phone",
  "partyEvent.requestAdded": "{song} was added to the Queue",
  "partyEvent.requestMovedUp": "{song} moved up",
  "partyEvent.requestMovedDown": "{song} moved down",
  "partyEvent.requestPlayNext": "{song} plays next",
  "partyEvent.requestRemoved": "{song} was removed from the Queue",
  "partyEvent.requestedPlayersChanged": "The singers of {song} changed",
  "toast.songMovedUp": "{actor} moved {song} up",
  "toast.backOnMic": "{actor} is back on the mic",
  // A colour parameter is always a palette display name (`colourName`).
  "toast.memberLeft": "{actor} left the Party. {colour} is free",

  // The Timing editor's edit list: one entry per edit, with the values
  // before and after it (GAP in ms, BPM as in the file, video gap in s).
  "timing.edit.moveSong":
    "Whole Song moved: GAP {from, number} → {to, number} ms",
  "timing.edit.nudgeSong":
    "Whole Song nudged: GAP {from, number} → {to, number} ms",
  "timing.edit.typeGap": "GAP typed: {from, number} → {to, number} ms",
  "timing.edit.typeBpm": "BPM typed: {from, number} → {to, number}",
  "timing.edit.typeVideoGap":
    "Video gap typed: {from, number} → {to, number} s",
  "timing.edit.typeVideoGapNew": "Video gap typed: {to, number} s",
  "timing.edit.stretchAroundPin":
    "Stretched around the pinned Line: BPM {fromBpm, number} → {toBpm, number}, GAP {fromGap, number} → {toGap, number} ms",
  "timing.edit.tempoAroundPlayhead":
    "Tempo around the playhead: BPM {fromBpm, number} → {toBpm, number}, GAP {fromGap, number} → {toGap, number} ms",
} as const satisfies Record<string, Entry>;
