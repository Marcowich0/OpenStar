//! Check A/V sync (v1 spec #53, ticket #163): whether it runs on the Stage,
//! which the server knows and tells every connection, so a Remote can show
//! its big −/+ and Done. The A/V offset itself is the Stage's: a Remote's
//! press is relayed to the Stage, which saves under its own browser id at
//! `PUT /api/av-offset`. No Admin PIN anywhere (`endpoints::ws_access`).

use openstar_protocol::av_offset::{AvSyncStep, is_av_offset};
use openstar_protocol::{Actor, PhoneId, ServerMessage, UserMessage};

use super::LiveState;
use crate::live::hub::ConnectionId;

/// What is known about the running check (#168): the Phone that started it
/// (`None` for the Stage), whose page shows the −/+ and Done, and the
/// Stage's A/V offset once the Stage has reported it.
#[derive(Default, Clone)]
pub(super) struct AvSyncCheck {
    started_by: Option<PhoneId>,
    av_offset_ms: Option<i32>,
}

impl AvSyncCheck {
    fn known(&self) -> bool {
        self.started_by.is_some() || self.av_offset_ms.is_some()
    }

    fn message(&self) -> ServerMessage {
        ServerMessage::AvSyncCheck {
            started_by: self.started_by.clone(),
            av_offset_ms: self.av_offset_ms,
        }
    }
}

impl LiveState {
    /// Starts the check, from the Stage or a joined Phone, unless a Song plays.
    pub(super) fn start_av_sync(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        if self.stage().connection.is_none() {
            return Err(UserMessage::NoStage);
        }
        if self
            .stage()
            .party
            .as_ref()
            .is_some_and(|party| party.playing.is_some())
        {
            return Err(UserMessage::NotWhileSongPlays);
        }
        if self.calibration_open() {
            return Err(UserMessage::CalibrationRunning);
        }
        if !self.stage().av_sync {
            let started_by = match actor {
                Actor::Member { .. } => self.phones.get(&id).cloned(),
                Actor::Stage | Actor::Admin => None,
            };
            let check = AvSyncCheck {
                started_by,
                av_offset_ms: None,
            };
            self.stage_mut().av_sync = true;
            self.stage_mut().av_sync_check = check.clone();
            self.hub.send_all(&ServerMessage::AvSync { running: true });
            if check.known() {
                self.hub.send_all(&check.message());
            }
        }
        Ok(())
    }

    /// A Remote's press while the check runs, relayed to the Stage.
    pub(super) fn step_av_sync(
        &mut self,
        id: ConnectionId,
        step: AvSyncStep,
    ) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        if !self.stage().av_sync {
            return Err(UserMessage::AvSyncNotRunning);
        }
        self.send_to_stage(&ServerMessage::StepAvSync { step });
        Ok(())
    }

    /// The active Stage's A/V offset while the check runs, for every Remote.
    pub(super) fn report_av_sync_offset(
        &mut self,
        id: ConnectionId,
        av_offset_ms: i32,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        if !self.stage().av_sync {
            return Err(UserMessage::AvSyncNotRunning);
        }
        if !is_av_offset(av_offset_ms) {
            return Err(UserMessage::InvalidMessage);
        }
        let check = &mut self.stage_mut().av_sync_check;
        check.av_offset_ms = Some(av_offset_ms);
        let message = check.message();
        self.hub.send_all(&message);
        Ok(())
    }

    /// Done, from the Stage or a joined Phone.
    pub(super) fn end_av_sync(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        self.av_sync_ended();
        Ok(())
    }

    /// Ends the check if it runs, and tells every connection. Also called
    /// when the Stage closes or moves, and when a Song starts.
    pub(super) fn av_sync_ended(&mut self) {
        if self.stage().av_sync {
            self.stage_mut().av_sync = false;
            self.stage_mut().av_sync_check = AvSyncCheck::default();
            self.hub.send_all(&ServerMessage::AvSync { running: false });
        }
    }

    /// Tells a new connection the check runs, after its live state.
    pub(super) fn tell_av_sync(&mut self, id: ConnectionId) {
        if self.stage().av_sync {
            self.hub
                .send_to(id, &ServerMessage::AvSync { running: true });
            let check = &self.stage().av_sync_check;
            if check.known() {
                let message = check.message();
                self.hub.send_to(id, &message);
            }
        }
    }
}
