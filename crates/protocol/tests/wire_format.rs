//! The JSON wire format of the protocol messages, pinned with `insta`
//! snapshots and a `proptest` property.

use openstar_protocol::library::SongId;
use openstar_protocol::mics::{LocalMicSource, MicKey, PartyLocalMic};
use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, PaletteKey, ProfileId};
use openstar_protocol::scoring::{PlayerResult, ScorePlayer};
use openstar_protocol::{
    Actor, ChangeEvent, ChangeTopic, ClientMessage, Identity, JoinAs, JoinCode, JoinedPhone,
    LineUp, LineUpWarning, PartyEvent, PartyId, PartyMember, PartyMemberId, PartySnapshot, PhoneId,
    PlayingSong, QueueMove, Request, RequestChange, RequestId, RequestKind, Seat, SeatVoice,
    ServerMessage, SongControl, SongEnd, SongResults, StageId, UserMessage,
};
use proptest::prelude::*;

fn party() -> PartySnapshot {
    PartySnapshot {
        party_id: PartyId("0123456789abcdef0123456789abcdef".to_owned()),
        stage_id: StageId("main".to_owned()),
        join_code: JoinCode("0427".to_owned()),
        started_at_ms: 1_764_000_000_000,
        members: vec![PartyMember {
            member_id: PartyMemberId(1),
            identity: Identity::Profile {
                profile_id: ProfileId(7),
            },
            colour: PaletteKey::Sky,
            favourite_taken: true,
            on_phone: true,
            singing: false,
        }],
        phones: vec![JoinedPhone {
            phone_id: PhoneId("3f2c9a51-7d1e-4f7a-9a43-0c2b5e8d1f60".to_owned()),
            member_id: PartyMemberId(1),
        }],
        queue: vec![
            Request {
                request_id: RequestId(3),
                kind: RequestKind::Song,
                song_id: SongId(12),
                requested_players: vec![PartyMemberId(1)],
                adder: Some(PartyMemberId(1)),
            },
            Request {
                request_id: RequestId(4),
                kind: RequestKind::Song,
                song_id: SongId(5),
                requested_players: Vec::new(),
                adder: None,
            },
        ],
        head: Some(RequestId(3)),
        line_up: Some(LineUp {
            request_id: RequestId(3),
            duet: true,
            seats: vec![Seat {
                member_id: PartyMemberId(1),
                mic: Some(MicKey::Phone {
                    phone_id: "3f2c9a51-7d1e-4f7a-9a43-0c2b5e8d1f60".to_owned(),
                }),
                voice: SeatVoice::P1,
                difficulty: Difficulty::Medium,
            }],
            can_start: false,
            warnings: vec![
                LineUpWarning::MicBlocked {
                    member_id: PartyMemberId(1),
                },
                LineUpWarning::DuetNeedsVoice {
                    voice: SeatVoice::P2,
                },
            ],
        }),
        playing: Some(PlayingSong {
            request_id: RequestId(3),
            song_id: SongId(12),
            paused: true,
        }),
        results: None,
        local_mics: vec![PartyLocalMic {
            local_mic_id: "browser:stage-1:device-1:0".to_owned(),
            source: LocalMicSource::Browser {
                stage_browser: "stage-1".to_owned(),
                device_id: "device-1".to_owned(),
                label: "USB Audio".to_owned(),
                channel: 0,
                stereo: true,
            },
            name: "Red mic".to_owned(),
            present: false,
        }],
    }
}

#[test]
fn play_messages_wire_format() {
    insta::assert_json_snapshot!(vec![
        ClientMessage::ControlSong {
            request_id: RequestId(3),
            control: SongControl::Start,
        },
        ClientMessage::CloseResults,
    ]);
    insta::assert_json_snapshot!(vec![
        ServerMessage::ControlSong {
            request_id: RequestId(3),
            song_id: SongId(12),
            control: SongControl::Skip,
        },
        ServerMessage::Rejected {
            reason: UserMessage::LineUpNotReady,
        },
    ]);
    insta::assert_json_snapshot!(SongResults {
        request_id: RequestId(3),
        song_id: SongId(12),
        ended: SongEnd::Played,
        players: vec![PlayerResult {
            member_id: PartyMemberId(4),
            player: ScorePlayer::Guest { name: "Cy".into() },
            name: "Cy".into(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            colour: PaletteKey::Grape,
            mic: Some(MicKey::Phone {
                phone_id: "phone-1".into(),
            }),
            voice: Some(1),
            difficulty: Difficulty::Hard,
            total: 6250,
            notes: 5000,
            golden: 250,
            line_bonus: 1000,
            place: 1,
            rank_title_band: 5,
            new_high_score: false,
            mic_lost: true,
            unfinished: false,
        }],
    });
    insta::assert_json_snapshot!(PartyEvent::SongPaused(RequestChange {
        request_id: RequestId(3),
        song_id: SongId(12),
        title: "Africa".to_owned(),
    }));
}

#[test]
fn mic_blocked_report_wire_format() {
    assert_eq!(
        serde_json::to_string(&ClientMessage::ReportMicBlocked { blocked: true }).unwrap(),
        r#"{"type":"reportMicBlocked","blocked":true}"#
    );
    insta::assert_json_snapshot!(PartyEvent::MicBlocked {
        member_id: PartyMemberId(1),
        name: "Bo".to_owned(),
    });
}

#[test]
fn queue_messages_wire_format() {
    insta::assert_json_snapshot!(vec![
        ClientMessage::AddRequest {
            song_id: SongId(12),
            requested_players: None,
        },
        ClientMessage::AddRequest {
            song_id: SongId(12),
            requested_players: Some(vec![PartyMemberId(2), PartyMemberId(1)]),
        },
        ClientMessage::MoveRequest {
            request_id: RequestId(4),
            to: QueueMove::Next,
        },
        ClientMessage::SetRequestedPlayers {
            request_id: RequestId(4),
            requested_players: Vec::new(),
        },
        ClientMessage::RemoveRequest {
            request_id: RequestId(4),
        },
    ]);
}

#[test]
fn queue_change_event_wire_format() {
    insta::assert_json_snapshot!(ChangeEvent {
        actor: Actor::Member {
            member_id: PartyMemberId(1),
        },
        event: PartyEvent::RequestMovedUp(RequestChange {
            request_id: RequestId(4),
            song_id: SongId(5),
            title: "Africa".to_owned(),
        }),
    });
}

#[test]
fn queue_refusal_codes_wire_format() {
    let wire = |message: &UserMessage| serde_json::to_string(message).unwrap();
    assert_eq!(
        wire(&UserMessage::TooManyPlayers { max: 4 }),
        r#"{"code":"tooManyPlayers","params":{"max":4}}"#
    );
    assert_eq!(
        wire(&UserMessage::SongPreparing),
        r#"{"code":"songPreparing"}"#
    );
}

#[test]
fn join_message_wire_format() {
    insta::assert_json_snapshot!(ClientMessage::Join {
        phone_id: PhoneId("3f2c9a51-7d1e-4f7a-9a43-0c2b5e8d1f60".to_owned()),
        join_code: JoinCode("0427".to_owned()),
        join_as: JoinAs::Profile {
            profile_id: ProfileId(7),
        },
    });
}

#[test]
fn phone_messages_wire_format() {
    let wire = |message: &ServerMessage| serde_json::to_string(message).unwrap();
    assert_eq!(
        wire(&ServerMessage::PhoneStatus {
            member_id: Some(PartyMemberId(2))
        }),
        r#"{"type":"phoneStatus","memberId":2}"#
    );
    assert_eq!(
        wire(&ServerMessage::PhoneStatus { member_id: None }),
        r#"{"type":"phoneStatus","memberId":null}"#
    );
    assert_eq!(wire(&ServerMessage::LeftParty), r#"{"type":"leftParty"}"#);
    assert_eq!(
        wire(&ServerMessage::JoinCodeValid {
            join_code: JoinCode("0427".to_owned())
        }),
        r#"{"type":"joinCodeValid","joinCode":"0427"}"#
    );
    assert_eq!(
        serde_json::from_str::<ClientMessage>(r#"{"type":"hello","phoneId":"a-1"}"#).unwrap(),
        ClientMessage::Hello {
            phone_id: PhoneId("a-1".to_owned())
        }
    );
    assert_eq!(
        serde_json::from_str::<ClientMessage>(r#"{"type":"checkJoinCode","joinCode":"0042"}"#)
            .unwrap(),
        ClientMessage::CheckJoinCode {
            join_code: JoinCode("0042".to_owned())
        }
    );
}

#[test]
fn member_joined_wire_format() {
    insta::assert_json_snapshot!(ChangeEvent {
        actor: Actor::Member {
            member_id: PartyMemberId(1),
        },
        event: PartyEvent::MemberJoined {
            member_id: PartyMemberId(1),
            name: "Bo".to_owned(),
            colour: PaletteKey::Sky,
        },
    });
}

#[test]
fn join_refusal_codes_wire_format() {
    let wire = |message: &UserMessage| serde_json::to_string(message).unwrap();
    assert_eq!(
        wire(&UserMessage::JoinCodeWrong),
        r#"{"code":"joinCodeWrong"}"#
    );
    assert_eq!(wire(&UserMessage::PartyFull), r#"{"code":"partyFull"}"#);
    assert_eq!(wire(&UserMessage::NotInParty), r#"{"code":"notInParty"}"#);
}

#[test]
fn a_phone_id_is_a_short_run_of_letters_digits_and_dashes() {
    assert!(PhoneId("3f2c9a51-7d1e-4f7a-9a43-0c2b5e8d1f60".to_owned()).is_valid());
    assert!(!PhoneId(String::new()).is_valid());
    assert!(!PhoneId("a".repeat(65)).is_valid());
    assert!(PhoneId("a".repeat(64)).is_valid());
    assert!(!PhoneId("has space".to_owned()).is_valid());
}

#[test]
fn rejected_message_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Rejected {
        reason: UserMessage::InvalidMessage,
    });
}

#[test]
fn refusal_code_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Rejected {
        reason: UserMessage::NotTheStage,
    });
}

#[test]
fn live_state_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::LiveState {
        stage_id: StageId("main".to_owned()),
        party: Some(party()),
        is_stage: true,
    });
}

#[test]
fn party_changed_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::PartyChanged {
        party: party(),
        change: ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::PartyStarted {
                join_code: JoinCode("0427".to_owned()),
            },
        },
    });
}

#[test]
fn member_actor_wire_format() {
    insta::assert_json_snapshot!(Actor::Member {
        member_id: PartyMemberId(3),
    });
}

#[test]
fn stage_moved_and_new_party_wire_format() {
    assert_eq!(
        serde_json::to_string(&ServerMessage::StageMoved).unwrap(),
        r#"{"type":"stageMoved"}"#
    );
    assert_eq!(
        serde_json::from_str::<ClientMessage>(r#"{"type":"newParty"}"#).unwrap(),
        ClientMessage::NewParty
    );
}

#[test]
fn change_notice_wire_format() {
    assert_eq!(
        serde_json::to_string(&ServerMessage::Changed {
            topics: vec![ChangeTopic::ServerInfo]
        })
        .unwrap(),
        r#"{"type":"changed","topics":["serverInfo"]}"#
    );
}

proptest! {
    #[test]
    fn every_ping_round_trips_through_json(nonce in any::<u32>()) {
        let ping = ClientMessage::Ping { nonce };
        let text = serde_json::to_string(&ping).unwrap();
        prop_assert_eq!(serde_json::from_str::<ClientMessage>(&text).unwrap(), ping);
    }

    #[test]
    fn every_party_snapshot_round_trips_through_json(code in "[0-9]{4}", started in any::<i64>()) {
        let snapshot = PartySnapshot { join_code: JoinCode(code), started_at_ms: started, ..party() };
        let json = serde_json::to_string(&snapshot).unwrap();
        prop_assert_eq!(serde_json::from_str::<PartySnapshot>(&json).unwrap(), snapshot);
    }
}

#[test]
fn pitch_track_start_wire_format() {
    use openstar_protocol::jobs::JobId;
    use openstar_protocol::pitch_track::PitchTrackStart;
    assert_eq!(
        serde_json::to_string(&PitchTrackStart::Ready).unwrap(),
        r#"{"state":"ready"}"#
    );
    assert_eq!(
        serde_json::to_string(&PitchTrackStart::Computing { job: JobId(7) }).unwrap(),
        r#"{"state":"computing","job":7}"#
    );
    assert_eq!(
        serde_json::to_string(&UserMessage::PitchTrackFailed).unwrap(),
        r#"{"code":"pitchTrackFailed"}"#
    );
}
