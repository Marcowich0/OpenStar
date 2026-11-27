// The join card and the Join chip as the Stage shows them: the live Join
// code, and the join address from `ServerInfo.publicUrl` or the address this
// Stage was opened on. Nothing shows until both are known, so a Stage never
// flashes a warning (or a QR code) it is about to take back.

import { useQuery } from "@tanstack/react-query";

import { serverInfoQuery } from "../../api/queries";
import { joinAddress, type JoinAddress } from "../../joinAddress";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { useStageFrame } from "../frame/stageFrameContext";
import { JoinCard, type JoinCardProps } from "./JoinCard";
import { JoinChip } from "./JoinChip";

const selectJoinCode = (live: LiveState) => live.stage?.party?.joinCode ?? null;

export type StageJoinCardProps = Pick<
  JoinCardProps,
  "hideable" | "storage" | "layout" | "hidden" | "onHiddenChange" | "className"
>;

/** The live Join code and join address, or `null` until both are known. */
function useStageJoin(): { joinCode: string; join: JoinAddress } | null {
  const { store } = useStageFrame();
  const joinCode = useLive(selectJoinCode, store);
  const info = useQuery(serverInfoQuery).data;
  if (joinCode === null || info === undefined) return null;
  return {
    joinCode,
    join: joinAddress(info.publicUrl, window.location.origin),
  };
}

export function StageJoinCard(props: StageJoinCardProps) {
  const known = useStageJoin();
  if (known === null) return null;
  return <JoinCard joinCode={known.joinCode} join={known.join} {...props} />;
}

/**
 * The Join chip of the Line-up and results (#250), in the bottom-left corner,
 * which holds nothing else on either scene (`e2e/tests/join-chip.spec.ts`
 * checks it): pressing it (or `P`) opens People, with the full join card.
 */
export function StageJoinChip() {
  const { openOverlay } = useStageFrame();
  const known = useStageJoin();
  if (known === null) return null;
  return (
    <JoinChip
      joinCode={known.joinCode}
      warning={known.join.warning}
      onPress={() => {
        openOverlay("people");
      }}
      className="absolute bottom-10 left-12"
    />
  );
}
