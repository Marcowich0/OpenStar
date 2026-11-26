//! Check A/V sync (v1 spec #53, ticket #163): whether it runs on the Stage,
//! which the server knows and tells every connection, so a Remote can show
//! its big −/+ and Done. The A/V offset itself is the Stage's: a Remote's
//! press is relayed to the Stage, which saves under its own browser id at
//! `PUT /api/av-offset`. No Admin PIN anywhere (`endpoints::ws_access`).

use openstar_protocol::av_offset::AvSyncStep;
use openstar_protocol::{ServerMessage, UserMessage};

use super::LiveState;
use crate::live::hub::ConnectionId;

impl LiveState {
    /// Starts the check, from the Stage or a joined Phone, unless a Song plays.
    pub(super) fn start_av_sync(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
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
            self.stage_mut().av_sync = true;
            self.hub.send_all(&ServerMessage::AvSync { running: true });
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
            self.hub.send_all(&ServerMessage::AvSync { running: false });
        }
    }

    /// Tells a new connection the check runs, after its live state.
    pub(super) fn tell_av_sync(&mut self, id: ConnectionId) {
        if self.stage().av_sync {
            self.hub
                .send_to(id, &ServerMessage::AvSync { running: true });
        }
    }
}
