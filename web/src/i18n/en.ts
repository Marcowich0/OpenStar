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

  // Toasts: structured events from the server, rendered on the Stage.
  "partyEvent.partyStarted": "New party started, Join code {joinCode}",
  "toast.songMovedUp": "{actor} moved {song} up",
  "toast.backOnMic": "{actor} is back on the mic",
} as const satisfies Record<string, Entry>;
