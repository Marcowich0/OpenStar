# OpenStar

A self-hosted karaoke game played in one room: one shared screen, singers on local microphones or their phones, songs from an UltraStar library.

## Language

### People

**Player**:
Someone singing in the current song, either as a Profile or as a Guest.
_Avoid_: User, singer, participant

**Profile**:
A returning person's persistent identity: a unique name, an avatar and a favourite colour, with no password. Anyone in the room may pick or edit any Profile. High scores belong to it.
_Avoid_: Account, user, login

**Guest**:
A person known only by a name, an avatar and a colour chosen for the current Party. A Guest has no Profile and never becomes one. A Guest's Score records are kept but never count as High scores.
_Avoid_: Anonymous, temporary user

### Devices

**Stage**:
The one shared screen in the room that shows the song, the lyrics and every Player's notes.
_Avoid_: Host, main screen, TV, client

**Phone**:
A personal device that has joined the current Party as a Profile or a Guest. It is always a Remote, and is a Player's microphone while it is in the Line-up.
_Avoid_: Mobile client, controller

**Remote**:
The role of a Phone when it browses the Library, changes the Queue or controls the Stage.
_Avoid_: Controller, companion

**Admin PIN**:
The one secret number that guards whatever changes the Library's files, deletes kept data, or makes a browser the Stage. It is set by the owner when OpenStar starts, and is not a Join code.
_Avoid_: Password, admin login, passcode

**Admin area**:
The screens for Downloads, Songs, Library problems and Profiles, reachable from the Stage's computer, a laptop or a Phone. Anyone may look; the guarded actions in it need the Admin PIN.
_Avoid_: Settings, admin panel, back office

**Unlock**:
A browser's permission to do guarded actions without entering the Admin PIN again. It ends after a while without use, or when locked by hand. Being the Stage is not an Unlock.
_Avoid_: Admin session, login, admin mode

**Stage trust**:
A browser being remembered as one that entered the Admin PIN to become the Stage, so it can become the Stage again with no PIN. It lasts until the Admin PIN changes. It is not an Unlock, and an Unlock is not Stage trust.
_Avoid_: Stage login, Stage session, trusted device

**Local mic**:
One input channel of a microphone or audio interface wired to a computer in the room, read either by the Stage itself or by a Mic bridge, and switched on as a Mic in the Stage's Mics setup. Each channel is its own Local mic, with its own name and Mic delay.
_Avoid_: Wired mic, channel, input

**Mic bridge**:
A small OpenStar app on a computer in the room that reads the Local mics wired to it and sends their Pitch readings to the Stage, as a Phone does. It works only while its window is open, and the Stage approves it once.
_Avoid_: Companion app, helper, agent, daemon

**Mic**:
A source of Pitch readings assigned to one Player: either a Local mic or a Phone.
_Avoid_: Input, audio source, device

**Pitch reading**:
One measurement of what a Mic heard at one moment: the pitch, how clearly it was a sung tone, and how loud.
_Avoid_: Sample, frame, pitch event

**Bleed**:
The Song's own sound reaching a Mic from the speakers, which must never score as singing.
_Avoid_: Echo, feedback, crosstalk

**Mic threshold**:
The loudness a Mic's Pitch reading must reach to count as singing, so that Bleed never scores. Each Mic has its own, set by Calibration or by hand (a Local mic's on the Stage, a Phone's on the Stage or on that Phone), and it stays the same for the whole of a Song.
_Avoid_: Loudness gate, noise gate, sensitivity

**Mic delay**:
How long after the Stage plays a sound a Mic's Pitch readings show it. Each Mic has its own, which depends on the Stage's sound output too.
_Avoid_: Latency, lag, offset

**Calibration**:
A run of tones the Stage plays while the Mics chosen for it listen at once, measuring each one's Mic delay. Someone starts it by hand; it is never part of a Song.
_Avoid_: Beep test, sync, timing check

**A/V offset**:
How much later the room hears a device's sound than its screen shows it, set by eye and ear for each sound output. It shifts what is drawn against Song time, never the Score.
_Avoid_: Video offset (that is a Song's video gap), latency, lag, audio delay

### Songs

**Library**:
The folder of UltraStar songs OpenStar reads from and writes to. It stays usable by other UltraStar programs.
_Avoid_: Collection, catalogue, song database

**Song**:
One entry in the Library: an UltraStar text file plus its audio and optional video, cover and background.
_Avoid_: Track, title

**Original**:
A Song's text file as it was before OpenStar first changed it, kept beside the Song so it can be restored.
_Avoid_: Backup, orig, source file

**Library problem**:
A file in the Library that was rejected as unplayable, is missing something it names, or duplicates another Song, shown to the admin with its reason.
_Avoid_: Error, broken song, scan failure

**USDB**:
The online database of UltraStar text files that Downloads come from. It offers texts only; the audio and video come from video sites.
_Avoid_: Song source, catalogue, store

**Download**:
Bringing one song from USDB into the Library as a new Song: its text, cover and one video chosen by the admin.
_Avoid_: Import, fetch, sync

**Voice**:
One sung part of a Song. A normal Song has one Voice; a duet has two.
_Avoid_: Track, part, P1/P2

**Line**:
One row of lyrics in a Voice and the Notes sung on it.
_Avoid_: Sentence, phrase, lyric line

**Beat**:
One step of a Song's time grid. Notes start on a Beat and last a whole number of Beats, and each Beat is judged once per Player.
_Avoid_: Tick, frame, step

**Note**:
One syllable to be sung in a Voice, with a start, a length and a pitch. It is Normal, Golden, Rap or Freestyle.
_Avoid_: Syllable, event

**Golden note**:
A Note worth twice a Normal note.
_Avoid_: Star note, bonus note

**Rap note**:
A Note hit by any voice, whatever its pitch. It can also be golden.
_Avoid_: Spoken note

**Freestyle note**:
A Note shown with its lyric but never scored.
_Avoid_: Free note, unscored note

**Song time**:
How far a Song's audio has played, in seconds from its start. Notes, lyrics and every Pitch reading are placed against it.
_Avoid_: Playback position, media time, timestamp

**Queue**:
The ordered list of Requests waiting to be sung on the Stage.
_Avoid_: Playlist, setlist

**Request**:
One entry in the Queue: a Song plus the Players asked to sing it.
_Avoid_: Queue item, booking, slot

### Play

**Difficulty**:
One of Easy, Medium or Hard, chosen per Player before a Song. It sets how far off pitch still counts as a hit, and nothing else.
_Avoid_: Level, mode

**Score**:
A Player's points for one Voice of one Song, from 0 to 10000: Note points plus the Line bonus.
_Avoid_: Points, result

**Line bonus**:
The part of a Score earned by how completely each Line was sung, worth up to 1000 in all.
_Avoid_: Sentence bonus, phrase bonus

**Line rating**:
The verdict on one Line, from 0 to 8, shown when the Line ends.
_Avoid_: Line score, popup

**Rank title**:
The name given to a Score on the results screen, one per band of points.
_Avoid_: Rating, grade, badge

**Finished**:
Said of a Score when the Song played past the last scored Note of the Player's Voice. Only a finished Score can be a high score.
_Avoid_: Complete, full play

**Party**:
One evening's run of the Stage, from pressing "New party" to the next one. The Queue and the joined Phones belong to it.
_Avoid_: Session, room, game

**Join code**:
The short code that lets a Phone join the current Party; a new Party gets a new one.
_Avoid_: Room code, PIN, session code

**Party member**:
A Profile or Guest that has entered the current Party, by joining on a Phone or by being seated on a Local mic. A Party holds at most twelve, one per Party colour.
_Avoid_: User, participant, attendee

**Party colour**:
One of twelve named colours in a fixed order, held by a Party member from entering the Party until they leave it or the Party ends, and held by no other Party member. A Profile gets its favourite colour when that is free, otherwise the first free one in that order.
_Avoid_: Player colour, team colour, slot colour

**Line-up**:
The Players set for the next Song, each with a mic, a Voice and a Difficulty.
_Avoid_: Roster, slots, team

**Score record**:
What one Player scored singing one Voice of one Song at one Difficulty, kept for every Song that reaches the results screen, including Songs ended early.
_Avoid_: Score, result, play

**High score**:
A Profile's best finished Score record for one Song, Voice and Difficulty. Guests, unfinished Songs and modes other than a normal full Song never count.
_Avoid_: Record, best, leaderboard entry

**Timing edit**:
A correction to when a Song's notes fall against its audio, saved back into the Library.
_Avoid_: Sync fix, alignment

**Pitch track**:
The pitch OpenStar hears in a Song's own audio, moment by moment, used only to fix the Song's timing. It is never a Mic's Pitch reading and is never scored.
_Avoid_: Vocal track, melody, reference pitch

**Auto-fit**:
A Timing edit proposed by matching a Song's Notes to its Pitch track. It runs only when someone chooses to fix a Song.
_Avoid_: Auto-sync, auto-align
