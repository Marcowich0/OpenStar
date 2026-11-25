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
  "join.connecting": "Finding the Party…",
  "join.title": "Join the Party",
  "join.typeCode": "Type the 4 numbers shown on the Stage, under the QR code",
  "join.whosSinging": "Who's singing?",
  "join.tapProfile": "Tap your Profile. You can change it later.",
  "join.here": "here",
  "join.newProfile": "New Profile",
  "join.guest": "I'm a Guest",
  "join.hi": "Hi {name}!",
  "join.remembered": "This phone remembers you.",
  "join.imName": "I'm {name}",
  "join.someoneElse": "Someone else",
  "join.profilesLoading": "Loading the Profiles…",
  "join.profilesFailed": "The Profiles could not be loaded",
  "join.colourTonight": "You're {colour} tonight",
  "join.usualColourHeld":
    "{holder} already has {favourite}, your usual colour. You get it back at the next Party",
  "join.usualColourTaken":
    "Someone already has {favourite}, your usual colour. You get it back at the next Party",
  "join.letsGo": "Let's go",
  "join.pickAnotherColour": "Pick another colour",
  "join.freeColours": "Free colours",
  "join.takeColour": "Take {colour}",
  "join.partyFull": "The Party is full",
  "join.partyFullWhy":
    "All 12 colours are taken tonight. Someone who is done singing can tap Leave party on their phone, or be removed from the Party people list.",
  "join.tryAgain": "Try again",
  "join.back": "Back",
  "joinForm.newGuest": "New Guest",
  "joinForm.name": "Name",
  "joinForm.namePlaceholder": "Your name for tonight",
  "joinForm.colour": "Colour",
  "joinForm.colourHint": "Crossed out ones are taken tonight",
  "joinForm.picture": "Picture",
  "joinForm.pictureNumber": "Picture {number, number}",
  "joinForm.areYou": "Are you {name}?",
  "joinForm.profileName": "That name belongs to a Profile.",
  "joinForm.yes": "Yes",
  "joinForm.nameTakenTonight": "Someone already has that name tonight",
  "joinForm.join": "Join",
  "joinForm.joinAs": "Join as {name}",
  "remote.tabs": "Remote",
  "remote.songs": "Songs",
  "remote.queue": "Queue",
  "remote.stage": "Stage",
  "remote.people": "People",

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

  // The sing screen's lane headers (#211).
  "sing.guest": "guest",
  "sing.voiceTag": "· V{voice, number}",

  // The Stage frame (#120): the pill row, the Setup menu and the overlays.
  "stage.pill.songs": "Songs",
  "stage.pill.queue": "Queue {count, number}",
  "stage.pill.people": "People {count, number}",
  "stage.pill.setup": "Setup",
  "stage.pills": "Stage menu",
  "stage.setup.menu": "Setup",
  "stage.overlay.songs": "Songs",
  "stage.overlay.queue": "Queue",
  "stage.overlay.people": "Tonight's Party",
  "stage.overlay.mics": "Mics",
  "stage.overlay.calibrateMics": "Calibrate mics",
  "stage.overlay.avSync": "Check A/V sync",
  "stage.overlay.close": "Close",
  "stage.overlay.comingSoon": "This screen is still being built.",
  // The Mics screen (Setup › Mics) and Local mic names.
  "mics.group.thisBrowser": "This browser",
  "mics.bridgeHint": "More than 2 inputs? Use a Mic bridge.",
  "mics.noDevices": "No input device found",
  "mics.allowMicrophone":
    "Allow this browser to use the microphone to list its inputs",
  "mics.unavailable": "This browser cannot read its microphones here",
  "mics.switchedOn": "On",
  "mics.switchedOff": "Off",
  "mics.switch": "{name} switched on",
  "mics.meter": "{name} level",
  "mics.localMic.left": "{label} · Left",
  "mics.localMic.right": "{label} · Right",
  "mics.localMic.mono": "{label}",
  "stage.queue.count": {
    one: "{count, number} Request in the Queue",
    other: "{count, number} Requests in the Queue",
  },
  "stage.people.count": "{count, number} of 12 colours taken",
  "stage.people.joinCode": "Join with {code}",
  "stage.newParty": "New party",

  // The Stage's scenes (#120 placeholders; #124, #164, #182 fill them).
  "stage.browser.pickFromPhone": "Pick a song from your phone",
  "stage.browser.joinCode": "Join code",
  "stage.browser.browse": "Or browse songs here",
  "stage.lineUp.title": "Line-up",
  "stage.sing.title": "Singing",
  "stage.results.title": "Results",
  "stage.moved.title": "The Stage moved to another screen",
  "stage.moved.body":
    "Someone opened OpenStar's Stage on another browser, so the party carries on there. Phones stay in the Party and follow it.",
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
  "userMessage.nameTakenTonight": "Someone already has that name tonight",
  "userMessage.colourTaken": "Someone else has that colour tonight",
  "userMessage.memberNotFound": "That person is no longer in the Party",
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
  "userMessage.memberSinging": "They are singing: take them off the Song first",
  "userMessage.useLeaveParty": "To leave the Party, use Leave party",

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

  "fileProblem.missingAudioReference":
    "Neither #MP3 nor #AUDIO names the audio",
  "fileProblem.audioNotFound":
    "#{header} names {reference}, which is not found",
  "fileProblem.mediaNotFound":
    "#{header} names {reference}, which is not found",
  "fileProblem.unreadableFile": "The file could not be read",
  "fileProblem.unreadableMetadata":
    "The metadata.json could not be read, so the Song is identified by its artist and title",
  "fileProblem.audioNotConverted":
    "The audio {file} does not play on the Stage and could not be converted",
  "fileProblem.videoNotConverted":
    "The video {file} does not play on the Stage and could not be converted, so the Song plays over its background",

  // Toasts: structured events from the server, rendered on the Stage and Phones.
  "partyEvent.partyStarted": "New party started, Join code {joinCode}",
  "partyEvent.memberJoined": "{name} joined the Party in {colour}",
  "partyEvent.phoneJoined": "{name} joined on another Phone",
  "partyEvent.memberChanged": "{name} changed their name, look or colour",
  "partyEvent.requestAdded": "{song} was added to the Queue",
  "partyEvent.requestMovedUp": "{song} moved up",
  "partyEvent.requestMovedDown": "{song} moved down",
  "partyEvent.requestPlayNext": "{song} plays next",
  "partyEvent.requestRemoved": "{song} was removed from the Queue",
  "partyEvent.requestedPlayersChanged": "The singers of {song} changed",
  "partyEvent.micBlocked": "{name}'s mic is blocked",
  "partyEvent.micOpened": "{name}'s mic is on",
  // Line-up warnings: the screen resolves the member's name.
  "lineUpWarning.noMic": "{name} has no mic",
  "lineUpWarning.micBlocked": "{name}'s mic is blocked",
  "lineUpWarning.duetNeedsVoice":
    "A duet needs someone on Voice {voice, number}",
  // Stage toasts that name the Remote's Party member (`stage/toasts/`).
  "toast.list": "Party changes",
  "toast.requestAdded": "{actor} added {song}",
  "toast.requestMovedUp": "{actor} moved {song} up",
  "toast.requestMovedDown": "{actor} moved {song} down",
  "toast.requestPlayNext": "{actor} made {song} play next",
  "toast.requestRemoved": "{actor} removed {song}",
  "toast.requestedPlayersChanged": "{actor} changed who sings {song}",
  // A colour parameter is always a palette display name (`colourName`).
  "toast.memberLeft": "{actor} left the Party. {colour} is free",
  // Toasts whose sender is not built yet: the server ticket that adds the
  // `PartyEvent` code maps it to one of these in `stage/toasts/toastContent.ts`.
  "toast.backOnMic": "{actor} is back on the mic",
  "toast.localMicBack": "{mic} is back on {actor}'s seat",
  "toast.soundOutputChanged": "Sound output changed: calibrate mics",
  "toast.requestDroppedSongGone":
    "{song} left the Library and was taken off the Queue",
  "toast.requestDroppedProfileDeleted":
    "{song} was taken off the Queue: {name}'s Profile was deleted",
  "toast.lineUpChanged": "{actor} changed the Line-up",
  "toast.seatVoice": "{actor} put {name} on Voice {voice, number}",
  "toast.seatDifficulty": "{actor} set {name} to {difficulty}",
  "toast.paused": "{actor} paused the Song",
  "toast.resumed": "{actor} resumed the Song",
  "toast.autoFitAccepted": "{actor} accepted the Auto-fit of {song}",

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
  // Line and Note edits: what moved ("Lines 3–5", "Note “la” in Line 3"),
  // then by how many whole Beats.
  "timing.lines.one": "Line {line, number}",
  "timing.lines.range": "Lines {first, number}–{last, number}",
  "timing.note": "Note “{text}” in Line {line, number}",
  "timing.edit.shiftLinesLater": {
    one: "{what}: +{count, number} beat",
    other: "{what}: +{count, number} beats",
  },
  "timing.edit.shiftLinesEarlier": {
    one: "{what}: −{count, number} beat",
    other: "{what}: −{count, number} beats",
  },
  "timing.edit.stretchLines": "{lines}: stretched ×{factor, number}",
  "timing.edit.moveNoteLater": {
    one: "{what} moved +{count, number} beat",
    other: "{what} moved +{count, number} beats",
  },
  "timing.edit.moveNoteEarlier": {
    one: "{what} moved −{count, number} beat",
    other: "{what} moved −{count, number} beats",
  },
  "timing.edit.noteLength": {
    one: "{note}: length {from, number} → {count, number} beat",
    other: "{note}: length {from, number} → {count, number} beats",
  },
} as const satisfies Record<string, Entry>;
