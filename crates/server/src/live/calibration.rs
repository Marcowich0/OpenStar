//! Calibrate mics (v1 spec #52, ticket #170): the one run, held by the
//! server and told to every connection, so the Stage, the chosen Phones and
//! (later) any Remote follow it. The checklist lists every joined Phone,
//! ticked; Continue asks the chosen Mics to listen; a Phone is ready after
//! "I'm listening"; the tones start when every chosen Mic is ready or on Go,
//! leaving out the Mics not ready. The Stage plays the tones, runs the
//! analysis and reports the successes, which are stored against the Stage
//! output in effect at Continue. Kept in memory only: a server restart ends
//! the run with nothing stored. No Admin PIN anywhere (`endpoints::ws_access`).

use openstar_protocol::mics::{
    CalibrationMic, CalibrationOutcome, CalibrationPhase, CalibrationResult, CalibrationRun,
    MicKey,
};
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};

use super::{server_error, LiveState};
use crate::live::hub::ConnectionId;

/// The open run on the active Stage.
pub(super) struct Calibration {
    run: CalibrationRun,
    /// The Stage output key at Continue; the results are stored against it.
    stage_output: Option<String>,
}

impl LiveState {
    /// Opens the checklist, from the Stage or a joined Phone, unless a Song
    /// plays or Check A/V sync runs. Every joined Phone starts ticked.
    pub(super) fn open_calibration(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        if self.stage().connection.is_none() {
            return Err(UserMessage::NoStage);
        }
        let Some(party) = self.stage().party.as_ref() else {
            return Err(UserMessage::NoStage);
        };
        if party.playing.is_some() {
            return Err(UserMessage::NotWhileSongPlays);
        }
        if self.stage().av_sync {
            return Err(UserMessage::AvSyncRunning);
        }
        if self.stage().calibration.is_some() {
            return Ok(());
        }
        let mics = party
            .phones
            .iter()
            .map(|phone| CalibrationMic {
                mic: MicKey::Phone {
                    phone_id: phone.phone_id.0.clone(),
                },
                chosen: true,
                ready: false,
                outcome: None,
            })
            .collect();
        self.stage_mut().calibration = Some(Calibration {
            run: CalibrationRun {
                phase: CalibrationPhase::Choosing,
                mics,
            },
            stage_output: None,
        });
        self.tell_calibration();
        Ok(())
    }

    /// Ticks or unticks a Mic on the checklist.
    pub(super) fn choose_calibration_mic(
        &mut self,
        id: ConnectionId,
        mic: MicKey,
        chosen: bool,
    ) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        let run = self.calibration_at(CalibrationPhase::Choosing)?;
        let entry = run
            .mics
            .iter_mut()
            .find(|entry| entry.mic == mic)
            .ok_or(UserMessage::InvalidMessage)?;
        if entry.chosen != chosen {
            entry.chosen = chosen;
            self.tell_calibration();
        }
        Ok(())
    }

    /// Continue: the chosen Mics are asked to listen.
    pub(super) fn start_calibration(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        let output = self
            .stage()
            .output
            .as_ref()
            .map(|(output, _)| output.stage_output.clone());
        let run = self.calibration_at(CalibrationPhase::Choosing)?;
        if !run.mics.iter().any(|entry| entry.chosen) {
            return Err(UserMessage::NoMicsChosen);
        }
        let Some(output) = output else {
            return Err(UserMessage::NoStage);
        };
        run.mics.retain(|entry| entry.chosen);
        run.phase = CalibrationPhase::Waiting;
        if let Some(calibration) = self.stage_mut().calibration.as_mut() {
            calibration.stage_output = Some(output);
        }
        self.tell_calibration();
        Ok(())
    }

    /// "I'm listening" from a chosen Phone. The last chosen Mic to get
    /// ready starts the tones.
    pub(super) fn calibration_listening(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        let phone_id = self
            .joined_phone(id)
            .map(|phone| phone.phone_id.0.clone())
            .ok_or(UserMessage::NotInCalibration)?;
        let mic = MicKey::Phone { phone_id };
        let run = self
            .stage_mut()
            .calibration
            .as_mut()
            .map(|calibration| &mut calibration.run)
            .ok_or(UserMessage::CalibrationNotRunning)?;
        let in_run = run.mics.iter().any(|entry| entry.mic == mic && entry.chosen);
        if !in_run {
            return Err(UserMessage::NotInCalibration);
        }
        if run.phase != CalibrationPhase::Waiting {
            return Err(UserMessage::CalibrationNotRunning);
        }
        for entry in run.mics.iter_mut().filter(|entry| entry.mic == mic) {
            entry.ready = true;
        }
        if run.mics.iter().all(|entry| entry.ready) {
            run.phase = CalibrationPhase::Tones;
        }
        self.tell_calibration();
        Ok(())
    }

    /// Go: the tones start now, with the Mics that are ready.
    pub(super) fn calibration_go(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        let run = self.calibration_at(CalibrationPhase::Waiting)?;
        if !run.mics.iter().any(|entry| entry.ready) {
            return Err(UserMessage::NoMicReady);
        }
        run.mics.retain(|entry| entry.ready);
        run.phase = CalibrationPhase::Tones;
        self.tell_calibration();
        Ok(())
    }

    /// The Stage's analysis: stores the successes, every other Mic in the
    /// run failed.
    pub(super) async fn finish_calibration(
        &mut self,
        id: ConnectionId,
        results: Vec<CalibrationResult>,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        let run = self.calibration_at(CalibrationPhase::Tones)?;
        let in_run = |mic: &MicKey| run.mics.iter().any(|entry| &entry.mic == mic);
        if !results.iter().all(|result| in_run(&result.mic)) {
            return Err(UserMessage::InvalidMessage);
        }
        let output = self
            .stage()
            .calibration
            .as_ref()
            .and_then(|calibration| calibration.stage_output.clone())
            .ok_or(UserMessage::CalibrationNotRunning)?;
        if !results.is_empty() {
            crate::mic_settings::store_calibration(self.db.clone(), output, results.clone())
                .await
                .map_err(|error| server_error(&error, "storing a Calibration"))?;
        }
        let run = self.calibration_at(CalibrationPhase::Tones)?;
        for entry in &mut run.mics {
            entry.outcome = Some(
                results
                    .iter()
                    .find(|result| result.mic == entry.mic)
                    .map_or(CalibrationOutcome::Failed, |result| {
                        CalibrationOutcome::Calibrated {
                            mic_delay_ms: result.mic_delay_ms,
                        }
                    }),
            );
        }
        run.phase = CalibrationPhase::Results;
        self.hub.send_all(&ServerMessage::Changed {
            topics: vec![ChangeTopic::MicSettings],
        });
        self.tell_calibration();
        Ok(())
    }

    /// Cancel or Done, from the Stage or a joined Phone.
    pub(super) fn end_calibration(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        self.calibration_ended();
        Ok(())
    }

    /// Ends the run if one is open, with nothing more stored, and tells
    /// every connection. Also called when the Stage closes or moves, a Song
    /// starts and a new Party starts.
    pub(super) fn calibration_ended(&mut self) {
        if self.stage_mut().calibration.take().is_some() {
            self.hub
                .send_all(&ServerMessage::Calibration { run: None });
        }
    }

    /// Tells a new connection the open run, after its live state.
    pub(super) fn tell_calibration_to(&mut self, id: ConnectionId) {
        if let Some(calibration) = &self.stage().calibration {
            let message = ServerMessage::Calibration {
                run: Some(calibration.run.clone()),
            };
            self.hub.send_to(id, &message);
        }
    }

    /// Whether a run is open (Check A/V sync cannot start then).
    pub(super) fn calibration_open(&self) -> bool {
        self.stage().calibration.is_some()
    }

    fn tell_calibration(&mut self) {
        let run = self
            .stage()
            .calibration
            .as_ref()
            .map(|calibration| calibration.run.clone());
        self.hub.send_all(&ServerMessage::Calibration { run });
    }

    /// The open run, if it is in `phase`.
    fn calibration_at(
        &mut self,
        phase: CalibrationPhase,
    ) -> Result<&mut CalibrationRun, UserMessage> {
        self.stage_mut()
            .calibration
            .as_mut()
            .map(|calibration| &mut calibration.run)
            .filter(|run| run.phase == phase)
            .ok_or(UserMessage::CalibrationNotRunning)
    }
}
