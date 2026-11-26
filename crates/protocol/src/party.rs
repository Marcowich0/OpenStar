//! The Party on the wire: its snapshot, the change events every accepted
//! change produces, and who made a change.
//!
//! After every accepted change the server sends every connected browser a
//! [`crate::ServerMessage::PartyChanged`]: the whole [`PartySnapshot`] plus
//! one [`ChangeEvent`]. A refused command gets a
//! [`crate::ServerMessage::Rejected`] with a [`crate::UserMessage`] code back.
//! Later Party tickets grow the snapshot (Party members, Queue, Line-up) and
//! add [`PartyEvent`] codes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::StageId;
use crate::library::SongId;
use crate::mics::{MicKey, PartyLocalMic};
use crate::profile::{Avatar, Difficulty, NewProfile, PaletteKey, ProfileId};
use crate::scoring::PlayerResult;

/// How many seats a Line-up has, and so how many requested Players a
/// Request may name. 4 in v1. Nothing else hard-codes it: no database CHECK,
/// fixed-size array or generated type.
pub const SEATS: usize = 4;

// The ceiling is the twelve Party colours: no two Players of a Line-up may
// share a colour.
const _: () = assert!(SEATS >= 1 && SEATS <= PaletteKey::ALL.len());

/// Names one Party. A new Party always gets a new id; Score records keep it,
/// so Guests can be told apart across evenings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PartyId(pub String);

/// The 4-digit code that lets a Phone join the current Party: four
/// characters `0`–`9`, kept as text so leading zeros survive. Not a secret,
/// and not the Admin PIN.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinCode(pub String);

/// Names one Party member within the Party. Numbered from 1 in the order
/// members enter it; a new Party starts again at 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PartyMemberId(pub u32);

/// The random id a browser makes on its first visit and keeps in its local
/// storage: how the server knows a Phone. Joined Phones, silent rejoin and a
/// Phone's Mic delay key on it. It is separate from the Profile id the Phone
/// remembers, since two Phones may hold one Profile.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PhoneId(pub String);

impl PhoneId {
    /// The longest Phone id the server accepts, in characters.
    pub const MAX_LENGTH: usize = 64;

    /// Whether this is a Phone id the server accepts: 1 to
    /// [`Self::MAX_LENGTH`] ASCII letters, digits and `-` (a UUID fits).
    pub fn is_valid(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= Self::MAX_LENGTH
            && self
                .0
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    }
}

/// Who a Party member is: a Profile or a Guest, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Identity {
    /// A Profile; its name and avatar come from `GET /api/profiles`.
    Profile { profile_id: ProfileId },
    /// A Guest: kept only for this Party, never converted or merged into a
    /// Profile.
    Guest {
        /// Trimmed, at most [`crate::profile::NAME_MAX_LENGTH`] characters,
        /// unique among the Party's Guests ignoring case and surrounding
        /// spaces, and no Profile's name.
        name: String,
        /// Any built-in avatar; other members may have the same one.
        avatar: Avatar,
        /// The Difficulty its next seat starts at: Medium until changed,
        /// kept for the Party.
        difficulty: Difficulty,
    },
}

/// Who a Phone joins (or switches) as, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum JoinAs {
    /// An existing Profile. Its Party colour is its favourite colour when
    /// free, otherwise the first free colour in palette order.
    Profile { profile_id: ProfileId },
    /// A new Guest, with a free colour.
    Guest(NewGuest),
    /// A new Profile, created and joined in one step: it is created only if
    /// it can enter the Party. Its favourite colour is its Party colour when
    /// free, otherwise it gets the first free one like any Profile.
    NewProfile(NewProfile),
}

/// A new Guest: what the Phone's form (or the Stage's) sends.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewGuest {
    /// Surrounding spaces are trimmed before the name is checked and stored.
    pub name: String,
    /// Must be free in the Party; the form preselects the first free one in
    /// palette order.
    pub colour: PaletteKey,
    pub avatar: Avatar,
}

/// A change to a Party member made inside the Party (the Me sheet's "Change
/// name, look or colour"): the fields to change; a missing field stays.
/// For a Profile, the name and avatar change the Profile and the colour
/// becomes both its favourite and its Party colour. For a Guest all three
/// are its own. The colour must be free (or the member's own).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemberEdit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar: Option<Avatar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub colour: Option<PaletteKey>,
}

/// A Profile or Guest that has entered the current Party.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartyMember {
    pub member_id: PartyMemberId,
    pub identity: Identity,
    /// Held by no other Party member, until this one leaves the Party or the
    /// Party ends. Never saved back into a Profile.
    pub colour: PaletteKey,
    /// The Profile's favourite colour was held by another member when it
    /// entered, so it got the first free colour instead.
    pub favourite_taken: bool,
    /// At least one joined Phone uses this identity ("On a Phone"); `false`
    /// means Local mic only.
    pub on_phone: bool,
    /// Sits in the head's Line-up ("singing"), waiting or with its Song
    /// playing, so it cannot leave or be removed. Computed by the server.
    pub singing: bool,
}

/// A Phone that has joined the current Party, and the Party member it uses
/// now. It stays joined while it sleeps or is disconnected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JoinedPhone {
    pub phone_id: PhoneId,
    pub member_id: PartyMemberId,
}

/// The whole Party, as every browser sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartySnapshot {
    pub party_id: PartyId,
    /// The Stage this Party runs on.
    pub stage_id: StageId,
    pub join_code: JoinCode,
    /// When the Party started, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub started_at_ms: i64,
    /// Every Party member, in the order they entered.
    pub members: Vec<PartyMember>,
    /// Every joined Phone, in the order they joined.
    pub phones: Vec<JoinedPhone>,
    /// The Queue: every Request waiting to be sung, in order.
    pub queue: Vec<Request>,
    /// The head of the Queue: the Request whose Line-up waits or whose Song
    /// plays. When set it is always the first Request; it never moves and
    /// nothing moves above it. `null` while the song browser or the results
    /// show.
    pub head: Option<RequestId>,
    /// The head's Line-up: waiting for Start (the "Line-up waiting" state)
    /// while `playing` is `null`, and fixed for the Song while it plays.
    /// `null` while the song browser or the results show. Prefilled from the
    /// head's Request when it becomes the head; it never starts by itself.
    pub line_up: Option<LineUp>,
    /// The head's Song while it plays or is paused (the sing screen), or
    /// `null`. Its Players are the seats of `line_up`, fixed at Start. Never
    /// kept across a restart: only the Song in progress is lost, and the
    /// Line-up waits again.
    pub playing: Option<PlayingSong>,
    /// The results of the Song that just ended, while the Stage shows them,
    /// or `null`. Its Request has left the Queue and there is no head until
    /// someone presses Next or Done ([`crate::ClientMessage::CloseResults`]).
    /// Kept across a restart.
    pub results: Option<SongResults>,
    /// Every switched-on Local mic, in Mics-screen order, with whether it
    /// is present: what the Mic lists of the Line-up offer. Not kept: made
    /// by the server from the kept Local mics and what the Stage and the
    /// Mic bridges report.
    pub local_mics: Vec<PartyLocalMic>,
}

/// The head's Song while it plays: the Party's 'playing' state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlayingSong {
    /// The head, whose Line-up is fixed until the Song ends.
    pub request_id: RequestId,
    pub song_id: SongId,
    /// Someone pressed Pause, and nobody has pressed Resume or Restart
    /// since.
    pub paused: bool,
}

/// The Song whose results the Stage shows: the Party's 'results' state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongResults {
    /// The Request that was sung; it has left the Queue.
    pub request_id: RequestId,
    pub song_id: SongId,
    pub ended: SongEnd,
    /// Every seated Player's result, ranked by total (best first; equal
    /// totals keep their seat order). Each Phone that was a Player's Mic
    /// finds its own result by `mic`.
    pub players: Vec<PlayerResult>,
}

/// How a Song reached its results screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SongEnd {
    /// It played to its end.
    Played,
    /// Someone pressed End: the results are marked unfinished.
    Ended,
}

impl SongEnd {
    /// The key stored in SQLite and sent on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Played => "played",
            Self::Ended => "ended",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        [Self::Played, Self::Ended]
            .into_iter()
            .find(|end| end.as_str() == key)
    }
}

/// What anyone may do to the head's Song, from the Stage or any Remote.
/// The server passes each accepted one to the Stage
/// ([`crate::ServerMessage::ControlSong`]), which acts on the Song clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SongControl {
    /// Begins the Song with the waiting Line-up as it stands; refused
    /// unless it can start. It does not wait for any Phone's mic.
    Start,
    /// A plain tap.
    Pause,
    /// A plain tap; the Stage counts 3-2-1 first.
    Resume,
    /// Held. Starts the Song over with a clean Score, and unpauses it.
    Restart,
    /// Held. Stops the Song early; its results still show, marked
    /// unfinished, once the Stage reports them.
    End,
    /// Held. Stops the Song with no results: its Request leaves the Queue
    /// at once and the next Line-up comes up.
    Skip,
}

/// Which Voice of a Song a seat sings: `p1`, or `p2` in a duet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SeatVoice {
    P1,
    P2,
}

impl SeatVoice {
    /// The key stored in SQLite and sent on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P1 => "p1",
            Self::P2 => "p2",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        [Self::P1, Self::P2]
            .into_iter()
            .find(|voice| voice.as_str() == key)
    }
}

/// One seat of a Line-up: who sings, on which Mic, which Voice and at
/// which Difficulty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Seat {
    pub member_id: PartyMemberId,
    /// A joined Phone or a switched-on Local mic; `null` when none was free
    /// ("<name> has no mic").
    pub mic: Option<MicKey>,
    /// Always `p1` for a one-Voice Song.
    pub voice: SeatVoice,
    pub difficulty: Difficulty,
}

/// The Players set for the head's Song, as the server holds and checks it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LineUp {
    /// The Request this Line-up is for: always the head.
    pub request_id: RequestId,
    /// The Song has two Voices, so seats choose between `p1` and `p2`.
    pub duet: bool,
    /// In seat order; at most [`SEATS`]. A member at most once is a rule
    /// checked by the server (see `canStart`), never a shape of this list.
    pub seats: Vec<Seat>,
    /// Whether Start may be pressed: at least one seat, every seat has a
    /// Mic, no Mic serves two seats, no member sits in two seats, and a
    /// duet has someone on each Voice. Computed by the server.
    pub can_start: bool,
    /// What the Stage and the Remotes show under the Line-up, in seat
    /// order, then the Song's own warnings. Computed by the server.
    pub warnings: Vec<LineUpWarning>,
}

/// A Line-up warning: a code plus its parameters, like [`crate::UserMessage`].
/// The screens resolve the member's name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LineUpWarning {
    /// "<name> has no mic": the seat has no Mic. Blocks Start.
    NoMic { member_id: PartyMemberId },
    /// "<name>'s mic is blocked": the seat's Mic is a Phone that reported
    /// its mic could not open. Does not block Start.
    MicBlocked { member_id: PartyMemberId },
    /// "A duet needs someone on Voice <voice>": nobody sits on that Voice
    /// of a duet. Blocks Start.
    DuetNeedsVoice { voice: SeatVoice },
}

/// Who to put in a Line-up seat: a Party member, a Profile (which enters
/// the Party when it is not a member yet), or a new Guest or new Profile
/// that enters the Party and takes the seat in one step (the Stage's
/// + Guest and + Profile). Tagged by `kind`, like [`JoinAs`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SeatWho {
    Member { member_id: PartyMemberId },
    Profile { profile_id: ProfileId },
    Guest(NewGuest),
    NewProfile(NewProfile),
}

/// One edit of the waiting Line-up, tagged by `kind`. Seats are numbered
/// from 0 in seat order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LineUpEdit {
    /// Changes who sits in `seat`. A member who sits in another seat moves:
    /// that seat is taken off. The seat keeps its Voice and a Local mic; a
    /// Phone of someone else is replaced by the Mic prefill rule.
    SetWho {
        seat: u32,
        who: SeatWho,
    },
    /// Add a singer: a new last seat, while fewer than [`SEATS`] are filled.
    /// A member who already sits in a seat moves to it.
    AddSeat {
        who: SeatWho,
    },
    /// A joined Phone or a switched-on Local mic that no other seat uses.
    SetMic {
        seat: u32,
        mic: MicKey,
    },
    /// Duets only.
    SetVoice {
        seat: u32,
        voice: SeatVoice,
    },
    SetDifficulty {
        seat: u32,
        difficulty: Difficulty,
    },
    /// "Take <name> off this Song": the seat goes; the member stays in the
    /// Party.
    RemoveSeat {
        seat: u32,
    },
}

/// Names one Request. Never reused, also across Parties.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestId(pub u32);

/// What a Request asks for. Always `song` in v1; later game modes add kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RequestKind {
    Song,
}

impl RequestKind {
    /// The key stored in SQLite and sent on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Song => "song",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        (key == "song").then_some(Self::Song)
    }
}

/// One entry of the Queue: a Library Song and the Players asked to sing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Request {
    pub request_id: RequestId,
    pub kind: RequestKind,
    pub song_id: SongId,
    /// The Party members asked to sing it, in order; at most [`SEATS`], no
    /// member twice, possibly none.
    pub requested_players: Vec<PartyMemberId>,
    /// The Party member who added it, or `null` when the Stage added it or
    /// that member has left the Party.
    pub adder: Option<PartyMemberId>,
}

/// Where a Request moves in the Queue. There is no arbitrary reorder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QueueMove {
    /// One place up, never above the head.
    Up,
    /// One place down.
    Down,
    /// Directly after the head (to the top when there is no head).
    Next,
}

/// The parameters of every Queue change event: which Request, and its Song
/// with the title it had at that moment (so a removed Request still names
/// its Song).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RequestChange {
    pub request_id: RequestId,
    pub song_id: SongId,
    pub title: String,
}

/// Who made a change: the Stage, or the Party member using the Phone that
/// made it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Actor {
    Stage,
    Member {
        member_id: PartyMemberId,
    },
    /// Nobody in the Party: the Admin area or the Library itself (a Song or
    /// Profile deleted, a Song gone at a Rescan). Its changes toast on the
    /// Stage too.
    Admin,
}

/// What changed: a code plus its parameters, `{ "code": ..., "params": {...} }`
/// like [`crate::UserMessage`]. The frontend turns it into a toast with
/// `t(code, params)`; no English crosses the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PartyEvent {
    /// A Party started, by itself on the first Stage open of a fresh server
    /// or by New party on the Stage, with this Join code.
    PartyStarted { join_code: JoinCode },
    /// A Phone joined, and with it a new Party member entered the Party with
    /// this Party colour. `name` is the member's name at that moment.
    MemberJoined {
        member_id: PartyMemberId,
        name: String,
        colour: PaletteKey,
    },
    /// A Phone joined as a Party member that was already in the Party (or
    /// switched to one): no member was added and no colour changed hands.
    PhoneJoined {
        member_id: PartyMemberId,
        name: String,
    },
    /// A Party member's name, avatar or Party colour was changed inside the
    /// Party. `name` is the member's name after the change.
    MemberChanged {
        member_id: PartyMemberId,
        name: String,
    },
    /// A Request was added at the end of the Queue.
    RequestAdded(RequestChange),
    /// A Request moved one place up.
    RequestMovedUp(RequestChange),
    /// A Request moved one place down.
    RequestMovedDown(RequestChange),
    /// A Request moved to directly after the head (Play next).
    RequestPlayNext(RequestChange),
    /// A Request left the Queue because someone removed it.
    RequestRemoved(RequestChange),
    /// A Request's requested Players changed.
    RequestedPlayersChanged(RequestChange),
    /// A Request left the Queue because its Song left the Library (deleted
    /// in the Admin area, or gone at a Rescan). `title` is the title the
    /// Song had in the Library.
    RequestDroppedSongGone(RequestChange),
    /// A Party member left the Party or was removed (the actor says which):
    /// its colour is free. Its name, avatar and colour travel here because
    /// it is no longer in the snapshot ("Lukas left the Party. Tangerine is
    /// free").
    MemberLeft {
        member_id: PartyMemberId,
        name: String,
        avatar: Avatar,
        colour: PaletteKey,
    },
    /// A Profile that was a Party member was deleted in the Admin area: it
    /// left the Party like [`PartyEvent::MemberLeft`], its colour is free,
    /// and every Phone using it is out of the Party.
    ProfileDeleted {
        member_id: PartyMemberId,
        name: String,
        avatar: Avatar,
        colour: PaletteKey,
    },
    /// A seated Phone reported that its mic could not open.
    MicBlocked {
        member_id: PartyMemberId,
        name: String,
    },
    /// A seated Phone whose mic was blocked reported that it opened.
    MicOpened {
        member_id: PartyMemberId,
        name: String,
    },
    /// The waiting Line-up changed: who sits where, a Mic, or a seat was
    /// added or taken off.
    LineUpChanged,
    /// The switched-on Local mics changed: one was switched on or off,
    /// renamed, plugged in or out, or its bridge opened or closed. No toast.
    LocalMicsChanged,
    /// A Party member who sat in one seat of the Line-up was chosen for
    /// another: it moved there and its old seat was taken off.
    SeatMoved {
        member_id: PartyMemberId,
        name: String,
    },
    /// A seat's Voice changed.
    SeatVoice {
        member_id: PartyMemberId,
        name: String,
        voice: SeatVoice,
    },
    /// A seat's Difficulty changed (on the Line-up, or from the Player's
    /// own Phone while seated).
    SeatDifficulty {
        member_id: PartyMemberId,
        name: String,
        difficulty: Difficulty,
    },
    /// A Player who is not seated set the Difficulty their next seat starts
    /// at, from their own Phone.
    NextDifficulty {
        member_id: PartyMemberId,
        name: String,
        difficulty: Difficulty,
    },
    /// Start: the head's Song began with its Line-up.
    SongStarted(RequestChange),
    /// The Song was paused.
    SongPaused(RequestChange),
    /// The paused Song was resumed.
    SongResumed(RequestChange),
    /// The Song was started over.
    SongRestarted(RequestChange),
    /// Someone pressed End; the results follow once the Stage shows them.
    SongEnded(RequestChange),
    /// The Song was skipped: its Request left the Queue with no results.
    SongSkipped(RequestChange),
    /// The Stage shows the Song's results (played out or ended early, see
    /// `results` in the snapshot); its Request left the Queue.
    ResultsShown(RequestChange),
    /// Someone pressed Next or Done on the results: the next Request's
    /// Line-up waits, or the song browser shows.
    ResultsClosed,
}

/// One accepted change: who made it and what it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeEvent {
    pub actor: Actor,
    pub event: PartyEvent,
}
