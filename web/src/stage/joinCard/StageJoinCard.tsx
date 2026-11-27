// The join card as the Stage shows it: the live Join code, and the join
// address from `ServerInfo.publicUrl` or the address this Stage was opened on.
// Nothing shows until both are known, so a Stage never flashes a warning (or a
// QR code) it is about to take back.

import { useQuery } from "@tanstack/react-query";

import { serverInfoQuery } from "../../api/queries";
import { joinAddress } from "../../joinAddress";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { useStageFrame } from "../frame/stageFrameContext";
import { JoinCard, type JoinCardProps } from "./JoinCard";

const selectJoinCode = (live: LiveState) => live.stage?.party?.joinCode ?? null;

export type StageJoinCardProps = Pick<
  JoinCardProps,
  "hideable" | "storage" | "layout" | "className"
>;

export function StageJoinCard(props: StageJoinCardProps) {
  const { store } = useStageFrame();
  const joinCode = useLive(selectJoinCode, store);
  const info = useQuery(serverInfoQuery).data;
  if (joinCode === null || info === undefined) return null;
  return (
    <JoinCard
      joinCode={joinCode}
      join={joinAddress(info.publicUrl, window.location.origin)}
      {...props}
    />
  );
}
