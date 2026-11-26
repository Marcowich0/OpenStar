//! Forget a Mic bridge (`DELETE /api/mic-bridges/{id}`, guarded): its
//! approval and its Local mics with their Mic settings go from the database
//! ([`crate::mic_bridges::forget`]), it leaves the approved bridges, and its
//! open connection closes, so the Stage sees its Local mics close. Its token
//! no longer lets it in: when it connects again it waits for approval with a
//! new code, like a new bridge.

use openstar_protocol::bridge::BridgeId;
use openstar_protocol::{ChangeTopic, ServerMessage};
use tokio::sync::oneshot;

use super::hub::ConnectionId;
use super::{Command, LiveHandle, LiveState};
use crate::mic_bridges;

impl LiveHandle {
    /// Forgets approved bridge `bridge_id` (see [`Command::ForgetBridge`]);
    /// `false` when no bridge with that id is approved.
    pub async fn forget_bridge(&self, bridge_id: BridgeId) -> anyhow::Result<bool> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::ForgetBridge { bridge_id, reply })
            .await
            .map_err(|_| anyhow::anyhow!("the live-state task has stopped"))?;
        answer.await?
    }
}

impl LiveState {
    pub(super) async fn forget_bridge(&mut self, bridge_id: BridgeId) -> anyhow::Result<bool> {
        if !self
            .bridges
            .approved
            .iter()
            .any(|approved| approved.bridge_id == bridge_id)
        {
            return Ok(false);
        }
        if !mic_bridges::forget(&self.db, bridge_id.clone()).await? {
            return Ok(false);
        }
        self.bridges
            .approved
            .retain(|approved| approved.bridge_id != bridge_id);
        let open: Vec<ConnectionId> = self
            .bridges
            .open
            .iter()
            .filter(|(_, open)| open.bridge_id == bridge_id)
            .map(|(&id, _)| id)
            .collect();
        for id in open {
            // Closed like any bridge: the Stage hears its Local mics close.
            self.bridge_closed(id);
            self.hub.remove(id);
        }
        tracing::info!("a Mic bridge was forgotten");
        self.hub.send_all(&ServerMessage::Changed {
            topics: vec![ChangeTopic::MicSettings, ChangeTopic::MicBridges],
        });
        self.reload_local_mics().await;
        Ok(true)
    }
}
