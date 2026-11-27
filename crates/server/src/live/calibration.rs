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
    LocalMicSource, MicKey,
};
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};

use super::{LiveState, server_error};
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
        self.may_open_calibration(id)?;
        if self.stage().calibration.is_some() {
            return Ok(());
        }
        let Some(party) = self.stage().party.as_ref() else {
            return Err(UserMessage::NoStage);
        };
        // Every joined Phone ticked, then every switched-on Local mic
        // unticked: wired mics are calibrated when switched on (#210).
        let phones = party.phones.iter().map(|phone| CalibrationMic {
            mic: MicKey::Phone {
                phone_id: phone.phone_id.0.clone(),
            },
            chosen: true,
            ready: false,
            outcome: None,
        });
        let local_mics = party.local_mics.iter().map(|local| CalibrationMic {
            mic: MicKey::LocalMic {
                local_mic_id: local.local_mic_id.clone(),
            },
            chosen: false,
            ready: false,
            outcome: None,
        });
        let mics = phones.chain(local_mics).collect();
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

    /// Whether `id` may open a run now: refused while a Song plays, during
    /// Check A/V sync and with no Stage.
    fn may_open_calibration(&self, id: ConnectionId) -> Result<(), UserMessage> {
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
        Ok(())
    }

    /// Calibrate mics from a "Not calibrated" seat: opens (or joins) the
    /// run, and on its checklist ticks `mic`, adding it when not listed.
    pub(super) fn open_calibration_for(
        &mut self,
        id: ConnectionId,
        mic: MicKey,
    ) -> Result<(), UserMessage> {
        let opened = !self.calibration_open();
        self.open_calibration(id)?;
        let Ok(run) = self.calibration_at(CalibrationPhase::Choosing) else {
            return Ok(());
        };
        let changed = match run.mics.iter_mut().find(|entry| entry.mic == mic) {
            Some(entry) => !std::mem::replace(&mut entry.chosen, true),
            None => {
                run.mics.push(CalibrationMic {
                    mic,
                    chosen: true,
                    ready: false,
                    outcome: None,
                });
                true
            }
        };
        // A run just opened was told already; tell the tick only if needed.
        if changed || opened {
            self.tell_calibration();
        }
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
        self.mark_local_mics_ready();
        self.tell_calibration();
        Ok(())
    }

    /// "Calibrate this mic now" (#210): the run with Local mic
    /// `local_mic_id` as its only Mic, past the checklist.
    pub(super) fn calibrate_local_mic_now(
        &mut self,
        id: ConnectionId,
        local_mic_id: String,
    ) -> Result<(), UserMessage> {
        self.may_open_calibration(id)?;
        if self.calibration_open() {
            return Err(UserMessage::CalibrationRunning);
        }
        let switched_on = self.stage().party.as_ref().is_some_and(|party| {
            party
                .local_mics
                .iter()
                .any(|local| local.local_mic_id == local_mic_id)
        });
        if !switched_on {
            return Err(UserMessage::InvalidMessage);
        }
        let output = self
            .stage()
            .output
            .as_ref()
            .map(|(output, _)| output.stage_output.clone())
            .ok_or(UserMessage::NoStage)?;
        self.stage_mut().calibration = Some(Calibration {
            run: CalibrationRun {
                phase: CalibrationPhase::Waiting,
                mics: vec![CalibrationMic {
                    mic: MicKey::LocalMic { local_mic_id },
                    chosen: true,
                    ready: false,
                    outcome: None,
                }],
            },
            stage_output: Some(output),
        });
        self.mark_local_mics_ready();
        self.tell_calibration();
        Ok(())
    }

    /// A Local mic's capture started or stopped (its Stage-browser device
    /// opened or closed, its Mic bridge connected or closed): the waiting
    /// run's Local mics are ready again by that, and everyone is told.
    pub(super) fn refresh_calibration_ready(&mut self) {
        if self.mark_local_mics_ready() {
            self.tell_calibration();
        }
    }

    /// While the run waits, marks each chosen Local mic ready exactly when
    /// its capture runs: a Stage-browser Local mic while the Stage reports
    /// its device open, a bridge Local mic while its bridge is connected
    /// and offers it (present). When every Mic is then ready the tones
    /// start. Whether anything changed.
    fn mark_local_mics_ready(&mut self) -> bool {
        let capturing = |local_mic_id: &str| {
            self.stage()
                .party
                .as_ref()
                .and_then(|party| {
                    party
                        .local_mics
                        .iter()
                        .find(|local| local.local_mic_id == local_mic_id)
                })
                .is_some_and(|local| match local.source {
                    LocalMicSource::Browser { .. } => {
                        self.capturing_browser_mics.contains(local_mic_id)
                    }
                    LocalMicSource::Bridge { .. } => local.present,
                })
        };
        let Some(run) = self
            .stage()
            .calibration
            .as_ref()
            .map(|calibration| &calibration.run)
            .filter(|run| run.phase == CalibrationPhase::Waiting)
        else {
            return false;
        };
        let ready: Vec<Option<bool>> = run
            .mics
            .iter()
            .map(|entry| match &entry.mic {
                MicKey::LocalMic { local_mic_id } => Some(capturing(local_mic_id)),
                MicKey::Phone { .. } => None,
            })
            .collect();
        let Ok(run) = self.calibration_at(CalibrationPhase::Waiting) else {
            return false;
        };
        let mut changed = false;
        for (entry, ready) in run.mics.iter_mut().zip(ready) {
            if let Some(ready) = ready
                && entry.ready != ready
            {
                entry.ready = ready;
                changed = true;
            }
        }
        if !run.mics.is_empty() && run.mics.iter().all(|entry| entry.ready) {
            run.phase = CalibrationPhase::Tones;
            changed = true;
        }
        changed
    }

    /// The Local mics whose detectors run for the run: every Local mic in
    /// it once it is past the checklist, until the results (#210).
    pub(super) fn calibration_local_mics(&self) -> impl Iterator<Item = &str> {
        self.stage()
            .calibration
            .as_ref()
            .map(|calibration| &calibration.run)
            .filter(|run| {
                matches!(
                    run.phase,
                    CalibrationPhase::Waiting | CalibrationPhase::Tones
                )
            })
            .into_iter()
            .flat_map(|run| run.mics.iter())
            .filter_map(|entry| match &entry.mic {
                MicKey::LocalMic { local_mic_id } => Some(local_mic_id.as_str()),
                MicKey::Phone { .. } => None,
            })
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
        let in_run = run
            .mics
            .iter()
            .any(|entry| entry.mic == mic && entry.chosen);
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
        self.refresh_calibrated().await;
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
            self.hub.send_all(&ServerMessage::Calibration { run: None });
            self.tell_bridges_detecting();
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
        self.tell_bridges_detecting();
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
