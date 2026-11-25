//! Editing the waiting Line-up over real HTTP and WebSocket, from the Stage
//! and any Phone: moving a member between seats, Mics, Voices,
//! Difficulties, Add a singer and taking a Player off; seating a Profile
//! that is not a member, a new Guest or a new Profile; "My Difficulty for
//! the next Song" from a Player's own Phone; and the snapshot marking seated
//! members as singing.

use std::path::Path;

use openstar_protocol::library::{SongId, SongList, SongSummary};
use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, Identity, JoinAs, JoinCode, LineUpEdit, LineUpWarning,
    NewGuest, PartyEvent, PartyMemberId, PartySnapshot, PhoneId, RequestId, SEATS, Seat, SeatVoice,
    SeatWho, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

fn star() -> Avatar {
    Avatar::BuiltIn {
        key: AvatarKey::Star,
    }
}

/// Writes a playable Song into `folder`; with `duet`, it has two Voices.
fn write_song(folder: &Path, title: &str, duet: bool) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(folder.join("song.mp3"), b"").unwrap();
    let body = if duet {
        "P1\n: 0 4 0 La\nP2\n: 8 4 0 Lo\nE\n"
    } else {
        ": 0 4 0 La\nE\n"
    };
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{body}"),
    )
    .unwrap();
}

/// A fresh app whose Library holds the one-Voice Song "Solo" and the duet
/// "Duet".
async fn app_with_songs() -> (TestApp, SongId, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo", false);
    write_song(&app.songs_dir().join("Duet"), "Duet", true);
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let id = |title: &str| songs.iter().find(|song| song.title == title).unwrap().id;
    let (solo, duet) = (id("Solo"), id("Duet"));
    (app, solo, duet)
}

/// The next message on `socket`, past change notices for HTTP data.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } => {}
            message => return message,
        }
    }
}

async fn party_changed(socket: &mut WsClient) -> (PartySnapshot, ChangeEvent) {
    match recv(socket).await {
        ServerMessage::PartyChanged { party, change } => (party, change),
        other => panic!("expected a Party change, got {other:?}"),
    }
}

/// Every socket hears the same change; returns it.
async fn all_hear(sockets: &mut [&mut WsClient]) -> (PartySnapshot, ChangeEvent) {
    let mut heard = Vec::new();
    for socket in sockets.iter_mut() {
        heard.push(party_changed(socket).await);
    }
    for other in &heard[1..] {
        assert_eq!(other, &heard[0]);
    }
    heard.swap_remove(0)
}

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

async fn create_profile(app: &TestApp, name: &str, favourite: PaletteKey) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: star(),
            favourite_colour: favourite,
        })
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    (stage, party.join_code)
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

fn phone_mic(n: u32) -> Option<MicKey> {
    Some(MicKey::Phone {
        phone_id: phone_id(n).0,
    })
}

/// Joins Phone `n` as `join_as`; returns its socket and member id, past
/// what the join sent it. Every socket in `others` hears the join.
async fn joined(
    app: &TestApp,
    others: &mut [&mut WsClient],
    code: &JoinCode,
    n: u32,
    join_as: JoinAs,
) -> (WsClient, PartyMemberId) {
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket
        .send(&ClientMessage::Join {
            phone_id: phone_id(n),
            join_code: code.clone(),
            join_as,
        })
        .await;
    let member_id = match recv(&mut socket).await {
        ServerMessage::PhoneStatus {
            member_id: Some(member_id),
        } => member_id,
        other => panic!("expected Phone {n}'s status, got {other:?}"),
    };
    party_changed(&mut socket).await;
    for other in others.iter_mut() {
        party_changed(other).await;
    }
    (socket, member_id)
}

fn edit(request_id: RequestId, edit: LineUpEdit) -> ClientMessage {
    ClientMessage::EditLineUp { request_id, edit }
}

fn member(member_id: PartyMemberId) -> SeatWho {
    SeatWho::Member { member_id }
}

fn singing(party: &PartySnapshot) -> Vec<PartyMemberId> {
    party
        .members
        .iter()
        .filter(|member| member.singing)
        .map(|member| member.member_id)
        .collect()
}

#[tokio::test]
async fn anyone_edits_the_waiting_line_up_and_start_is_rechecked_after_every_edit() {
    let (mut app, _solo, duet) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let ann = create_profile(&app, "Ann", PaletteKey::Lime).await;
    let (mut bo_phone, bo_id) = joined(
        &app,
        &mut [&mut stage],
        &code,
        1,
        JoinAs::Profile { profile_id: bo.id },
    )
    .await;
    let (mut ann_phone, ann_id) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone],
        &code,
        2,
        JoinAs::Profile { profile_id: ann.id },
    )
    .await;

    // Bo asks for the duet with Ann: Bo on Voice 1, Ann on Voice 2.
    bo_phone
        .send(&ClientMessage::AddRequest {
            song_id: duet,
            requested_players: Some(vec![bo_id, ann_id]),
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    let line_up = party.line_up.clone().unwrap();
    let request = line_up.request_id;
    assert!(line_up.can_start);
    assert_eq!(singing(&party), vec![bo_id, ann_id]);

    // Ann's Phone puts Ann in Bo's seat 0: Ann moves there with her own
    // Phone and seat 0's Voice, her old seat is taken off, and Bo is off
    // the Song.
    ann_phone
        .send(&edit(
            request,
            LineUpEdit::SetWho {
                seat: 0,
                who: member(ann_id),
            },
        ))
        .await;
    let (party, change) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member { member_id: ann_id },
            event: PartyEvent::SeatMoved {
                member_id: ann_id,
                name: "Ann".into(),
            },
        }
    );
    let line_up = party.line_up.clone().unwrap();
    assert_eq!(
        line_up.seats,
        vec![Seat {
            member_id: ann_id,
            mic: phone_mic(2),
            voice: SeatVoice::P1,
            difficulty: Difficulty::Medium,
        }]
    );
    assert!(!line_up.can_start);
    assert_eq!(
        line_up.warnings,
        vec![LineUpWarning::DuetNeedsVoice {
            voice: SeatVoice::P2
        }]
    );
    // Bo is no longer singing, so Bo may leave or be removed again.
    assert_eq!(singing(&party), vec![ann_id]);

    // The Stage adds Bo back with Add a singer: Voice 2, Bo's own Phone.
    stage
        .send(&edit(request, LineUpEdit::AddSeat { who: member(bo_id) }))
        .await;
    let (party, change) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    assert_eq!(change.event, PartyEvent::LineUpChanged);
    let line_up = party.line_up.clone().unwrap();
    assert_eq!(line_up.seats[1].member_id, bo_id);
    assert_eq!(line_up.seats[1].voice, SeatVoice::P2);
    assert_eq!(line_up.seats[1].mic, phone_mic(1));
    assert!(line_up.can_start);

    // A Mic in use in another seat is refused; so is one that is neither a
    // joined Phone nor a switched-on Local mic.
    let set_mic = |seat, mic: Option<MicKey>| {
        edit(
            request,
            LineUpEdit::SetMic {
                seat,
                mic: mic.unwrap(),
            },
        )
    };
    assert_eq!(
        refused(&mut stage, set_mic(0, phone_mic(1))).await,
        UserMessage::MicInUse
    );
    assert_eq!(
        refused(
            &mut stage,
            set_mic(
                0,
                Some(MicKey::LocalMic {
                    local_mic_id: "red".into()
                })
            )
        )
        .await,
        UserMessage::MicNotAvailable
    );

    // Voice and Difficulty, each with its own event.
    bo_phone
        .send(&edit(
            request,
            LineUpEdit::SetVoice {
                seat: 1,
                voice: SeatVoice::P1,
            },
        ))
        .await;
    let (party, change) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    assert_eq!(
        change.event,
        PartyEvent::SeatVoice {
            member_id: bo_id,
            name: "Bo".into(),
            voice: SeatVoice::P1,
        }
    );
    assert!(!party.line_up.unwrap().can_start);
    stage
        .send(&edit(
            request,
            LineUpEdit::SetDifficulty {
                seat: 1,
                difficulty: Difficulty::Hard,
            },
        ))
        .await;
    let (party, change) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::SeatDifficulty {
                member_id: bo_id,
                name: "Bo".into(),
                difficulty: Difficulty::Hard,
            },
        }
    );
    assert_eq!(party.line_up.unwrap().seats[1].difficulty, Difficulty::Hard);

    // Taking Ann off the Song removes the seat and leaves Ann in the Party.
    stage
        .send(&edit(request, LineUpEdit::RemoveSeat { seat: 0 }))
        .await;
    let (party, change) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    assert_eq!(change.event, PartyEvent::LineUpChanged);
    assert_eq!(party.members.len(), 2);
    assert_eq!(singing(&party), vec![bo_id]);
    let line_up = party.line_up.clone().unwrap();
    assert_eq!(line_up.seats.len(), 1);
    assert_eq!(line_up.seats[0].member_id, bo_id);

    // Edits name the Line-up they mean, and the seat must exist.
    assert_eq!(
        refused(
            &mut stage,
            edit(RequestId(request.0 + 1), LineUpEdit::RemoveSeat { seat: 0 })
        )
        .await,
        UserMessage::LineUpNotWaiting
    );
    assert_eq!(
        refused(
            &mut stage,
            edit(request, LineUpEdit::RemoveSeat { seat: 3 })
        )
        .await,
        UserMessage::SeatNotFound
    );

    // The edited Line-up survives a restart.
    drop((stage, bo_phone, ann_phone));
    app.restart().await;
    let mut stage = app.connect_stage().await;
    let party = live_party(&mut stage).await.unwrap();
    assert_eq!(party.line_up.as_ref().unwrap().seats, line_up.seats);
    assert_eq!(singing(&party), vec![bo_id]);
}

#[tokio::test]
async fn seating_someone_who_is_not_a_member_enters_them_into_the_party() {
    let (app, solo, _duet) = app_with_songs().await;
    let (mut stage, _code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let cy = create_profile(&app, "Cy", PaletteKey::Sky).await;
    stage
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let (party, _) = party_changed(&mut stage).await;
    let request = party.head.unwrap();
    assert!(party.line_up.unwrap().seats.is_empty());

    // A Profile that is not yet a member becomes one, with its favourite
    // colour when free; it has no Phone, so its seat has no Mic.
    stage
        .send(&edit(
            request,
            LineUpEdit::AddSeat {
                who: SeatWho::Profile { profile_id: bo.id },
            },
        ))
        .await;
    let (party, change) = party_changed(&mut stage).await;
    let bo_id = party.members[0].member_id;
    assert_eq!(
        change.event,
        PartyEvent::MemberJoined {
            member_id: bo_id,
            name: "Bo".into(),
            colour: PaletteKey::Sky,
        }
    );
    assert_eq!(singing(&party), vec![bo_id]);
    assert!(!party.members[0].on_phone);
    assert_eq!(
        party.line_up.unwrap().warnings,
        vec![LineUpWarning::NoMic { member_id: bo_id }]
    );

    // Cy's favourite is taken by Bo, so Cy gets the first free colour.
    stage
        .send(&edit(
            request,
            LineUpEdit::AddSeat {
                who: SeatWho::Profile { profile_id: cy.id },
            },
        ))
        .await;
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!(party.members[1].colour, PaletteKey::ALL[0]);
    assert!(party.members[1].favourite_taken);

    // + Guest under the Guest name rules: no Profile's name.
    let guest = |name: &str, colour| {
        SeatWho::Guest(NewGuest {
            name: name.to_owned(),
            colour,
            avatar: star(),
        })
    };
    assert_eq!(
        refused(
            &mut stage,
            edit(
                request,
                LineUpEdit::AddSeat {
                    who: guest(" bo ", PaletteKey::Lime)
                }
            )
        )
        .await,
        UserMessage::ProfileNameTaken { profile_id: bo.id }
    );

    // + Profile creates the Profile, enters it and seats it in one step.
    let new_profile = |name: &str| {
        SeatWho::NewProfile(NewProfile {
            name: name.to_owned(),
            avatar: star(),
            favourite_colour: PaletteKey::Lime,
        })
    };
    stage
        .send(&edit(
            request,
            LineUpEdit::SetWho {
                seat: 1,
                who: new_profile("Dee"),
            },
        ))
        .await;
    let (party, change) = party_changed(&mut stage).await;
    let dee = party.members[2].clone();
    assert!(matches!(change.event, PartyEvent::MemberJoined { ref name, .. } if name == "Dee"));
    assert_eq!(dee.colour, PaletteKey::Lime);
    // Cy left the seat but stays in the Party.
    assert_eq!(party.members.len(), 3);
    assert_eq!(singing(&party), vec![bo_id, dee.member_id]);
    let profiles: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(profiles.iter().any(|profile| profile.name == "Dee"));

    // Eve's Profile exists before the Party fills (a full Party refuses
    // creating one).
    let eve = create_profile(&app, "Eve", PaletteKey::Sky).await;

    // Fill the Party to twelve with Guests seated over seat 0.
    let free: Vec<PaletteKey> = PaletteKey::ALL
        .into_iter()
        .filter(|colour| !party.members.iter().any(|m| m.colour == *colour))
        .collect();
    for (n, colour) in free.into_iter().enumerate() {
        stage
            .send(&edit(
                request,
                LineUpEdit::SetWho {
                    seat: 0,
                    who: guest(&format!("Guest {n}"), colour),
                },
            ))
            .await;
        party_changed(&mut stage).await;
    }

    // Twelve colours held: nobody new can be seated.
    for who in [
        SeatWho::Profile { profile_id: eve.id },
        new_profile("Fay"),
        guest("Gus", PaletteKey::Sky),
    ] {
        assert_eq!(
            refused(
                &mut stage,
                edit(request, LineUpEdit::SetWho { seat: 0, who })
            )
            .await,
            UserMessage::PartyFull
        );
    }
    let profiles: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(!profiles.iter().any(|profile| profile.name == "Fay"));

    // A Profile that is already a member is still seated.
    stage
        .send(&edit(
            request,
            LineUpEdit::SetWho {
                seat: 0,
                who: SeatWho::Profile { profile_id: cy.id },
            },
        ))
        .await;
    let (party, change) = party_changed(&mut stage).await;
    assert_eq!(change.event, PartyEvent::LineUpChanged);
    assert_eq!(party.members.len(), 12);

    // Add a singer stops at the seat count.
    let line_up = party.line_up.unwrap();
    let mut seated = line_up.seats.len();
    for member in party.members.iter().filter(|m| !m.singing) {
        if seated == SEATS {
            assert_eq!(
                refused(
                    &mut stage,
                    edit(
                        request,
                        LineUpEdit::AddSeat {
                            who: SeatWho::Member {
                                member_id: member.member_id
                            }
                        }
                    )
                )
                .await,
                UserMessage::TooManyPlayers { max: SEATS as u32 }
            );
            break;
        }
        stage
            .send(&edit(
                request,
                LineUpEdit::AddSeat {
                    who: SeatWho::Member {
                        member_id: member.member_id,
                    },
                },
            ))
            .await;
        party_changed(&mut stage).await;
        seated += 1;
    }
}

#[tokio::test]
async fn my_difficulty_sets_my_seat_or_where_my_next_seat_starts() {
    let (app, solo, _duet) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let cy = create_profile(&app, "Cy", PaletteKey::Lime).await;
    let (mut bo_phone, bo_id) = joined(
        &app,
        &mut [&mut stage],
        &code,
        1,
        JoinAs::Profile { profile_id: bo.id },
    )
    .await;
    let (mut gus_phone, gus_id) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone],
        &code,
        2,
        JoinAs::Guest(NewGuest {
            name: "Gus".into(),
            colour: PaletteKey::Tangerine,
            avatar: star(),
        }),
    )
    .await;
    let (mut cy_phone, cy_id) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone, &mut gus_phone],
        &code,
        3,
        JoinAs::Profile { profile_id: cy.id },
    )
    .await;
    let mut everyone = [&mut stage, &mut bo_phone, &mut gus_phone, &mut cy_phone];
    everyone[1]
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let (party, _) = all_hear(&mut everyone).await;
    let request = party.head.unwrap();

    // Bo is seated: Bo's seat changes.
    let my = |difficulty| ClientMessage::SetMyDifficulty { difficulty };
    everyone[1].send(&my(Difficulty::Hard)).await;
    let (party, change) = all_hear(&mut everyone).await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member { member_id: bo_id },
            event: PartyEvent::SeatDifficulty {
                member_id: bo_id,
                name: "Bo".into(),
                difficulty: Difficulty::Hard,
            },
        }
    );
    assert_eq!(party.line_up.unwrap().seats[0].difficulty, Difficulty::Hard);

    // Gus (a Guest) and Cy (a Profile) are not seated: their next seat
    // starts at what they chose.
    everyone[2].send(&my(Difficulty::Easy)).await;
    let (party, change) = all_hear(&mut everyone).await;
    assert_eq!(
        change.event,
        PartyEvent::NextDifficulty {
            member_id: gus_id,
            name: "Gus".into(),
            difficulty: Difficulty::Easy,
        }
    );
    assert!(matches!(
        party.members[1].identity,
        Identity::Guest {
            difficulty: Difficulty::Easy,
            ..
        }
    ));
    everyone[3].send(&my(Difficulty::Hard)).await;
    let (_, change) = all_hear(&mut everyone).await;
    assert!(
        matches!(change.event, PartyEvent::NextDifficulty { member_id, .. } if member_id == cy_id)
    );
    let cy_now: Profile = app.get_json(&format!("/api/profiles/{}", cy.id.0)).await;
    assert_eq!(cy_now.last_difficulty, Difficulty::Hard);

    let mut party = party;
    for who in [gus_id, cy_id] {
        everyone[0]
            .send(&edit(
                request,
                LineUpEdit::AddSeat {
                    who: SeatWho::Member { member_id: who },
                },
            ))
            .await;
        party = all_hear(&mut everyone).await.0;
    }
    let difficulties: Vec<Difficulty> = party
        .line_up
        .unwrap()
        .seats
        .iter()
        .map(|seat| seat.difficulty)
        .collect();
    assert_eq!(
        difficulties,
        vec![Difficulty::Hard, Difficulty::Easy, Difficulty::Hard]
    );

    // The Stage has no Difficulty of its own.
    assert_eq!(
        refused(everyone[0], my(Difficulty::Easy)).await,
        UserMessage::NotInParty
    );
}
