// The Remote's Stage tab (v1 spec #49, "Stage tab"): what the Stage is doing,
// in one card per state (`stageState`), and the OpenStar volume under it in
// every state. The waiting Line-up's card: "Up next: who sings?" with the
// Song's cover and title, one row per seat, "Add a singer", the server's
// warnings, and a big Start. The playing Song's card (`PlayingCard`), the
// results' card (`ResultsCard`) with this Phone's own Player's result and
// its Rank title inside, and the empty Queue's (`EmptyQueueCard`) are in
// `../onStage/`. No level meters and no Mic threshold here: those are on the
// Stage.

import { useState } from "react";

import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PhoneId } from "../../generated/PhoneId";
import type { Seat } from "../../generated/Seat";
import { difficultyName, voiceNumber } from "../../i18n/seatNames";
import { rankTitle } from "../../i18n/rankTitles";
import { lineUpWarningText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { SEATS } from "../../live/seats";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Cover } from "../../ui/Cover";
import { Icon } from "../../ui/Icon";
import {
  AvSyncCard,
  AvSyncStartButton,
  useAvSyncRunning,
} from "../onStage/AvSyncCard";
import {
  CalibrateMicsButton,
  CalibrationCard,
  useCalibrationRun,
} from "../onStage/CalibrationCard";
import { PlayingCard } from "../onStage/PlayingCard";
import { EmptyQueueCard, ResultsCard } from "../onStage/ResultsCard";
import { VolumeControl } from "../onStage/VolumeControl";
import { stageState } from "../remoteFrame";
import { editLineUp, startSong } from "./lineUpCommands";
import { SeatSheet, Tag } from "./SeatSheet";
import { myResult } from "./myResult";
import { micName } from "./seatMics";
import { useLineUp } from "./useLineUp";

export function StageTab({
  store,
  myPhoneId,
}: {
  store: LiveStore;
  myPhoneId: PhoneId;
}) {
  const data = useLineUp(store);
  const { party, lineUp, song, localMics, members, memberOf, lookOf, nameOf } =
    data;
  // The sheet follows the member in the seat, so a move keeps it on the seat.
  const [open, setOpen] = useState<PartyMemberId | null>(null);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);

  const free = lineUp
    ? members.find((m) => !lineUp.seats.some((s) => s.memberId === m.memberId))
    : undefined;

  function addSinger() {
    if (!lineUp || !free || adding) return;
    setAdding(true);
    const memberId = free.memberId;
    void editLineUp(store, lineUp.requestId, {
      kind: "addSeat",
      who: { kind: "member", memberId },
    }).then((result) => {
      setAdding(false);
      if (result.ok) setOpen(memberId);
    });
  }

  function start() {
    if (!lineUp || starting) return;
    setStarting(true);
    void startSong(store, lineUp.requestId).then(() => {
      setStarting(false);
    });
  }

  function seatDetails(seat: Seat): string {
    const parts = [
      seat.mic && party
        ? micName(seat.mic, { party, myPhoneId, localMics, nameOf })
        : "",
      lineUp?.duet
        ? t("stageTab.voiceNumber", { voice: voiceNumber(seat.voice) })
        : "",
      difficultyName(seat.difficulty),
    ];
    return parts.filter((part) => part !== "").join(" · ");
  }

  // "Not calibrated" shows in its seat's row (with its button), not again
  // in the list under the seats.
  const listed =
    lineUp?.warnings.filter((w) => w.code !== "notCalibrated") ?? [];

  const mine = myResult(party?.results ?? null, myPhoneId);
  const state = stageState(party);
  const avSync = useAvSyncRunning(store);
  const calibration = useCalibrationRun(store);
  // Setup (Calibrate mics, Check A/V sync) only while no Song plays, and
  // only one of them at a time.
  const setup =
    !avSync &&
    calibration === null &&
    (state?.kind === "lineUp" || state?.kind === "empty");

  return (
    <div className="flex flex-col gap-3 pt-1">
      <h1 className="text-3xl font-bold">{t("stageTab.title")}</h1>
      {avSync && <AvSyncCard store={store} />}
      {calibration && <CalibrationCard store={store} run={calibration} />}
      {state?.kind === "results" && (
        <ResultsCard store={store} results={state}>
          {mine && (
            <div
              data-testid="my-result"
              className="mt-2 flex flex-col gap-1 rounded-[20px] bg-white/10 p-3"
            >
              <p className="text-2xl font-bold tabular-nums">
                {t("stageTab.yourScore", { total: mine.total })}
              </p>
              <p className="font-semibold">{rankTitle(mine.rankTitleBand)}</p>
              {mine.newHighScore && (
                <p className="font-semibold text-yellow">
                  {t("stageTab.newHighScore")}
                </p>
              )}
              {mine.unfinished && (
                <p className="text-white/70">{t("stageTab.endedEarly")}</p>
              )}
            </div>
          )}
        </ResultsCard>
      )}
      {state?.kind === "playing" && (
        <PlayingCard store={store} playing={state} />
      )}
      {state?.kind === "empty" && <EmptyQueueCard />}
      {lineUp && (
        <section className="flex flex-col gap-2 rounded-card bg-ink p-4.5 text-white shadow-ledge">
          <div className="mb-2 flex items-center gap-3">
            <Cover
              src={song?.media.cover ?? null}
              tileColour={song?.media.tileColour ?? "teal"}
              rim={2}
              className="w-13 shrink-0"
            />
            <div className="flex min-w-0 flex-col">
              <p className="text-sm font-semibold text-yellow">
                {t("stageTab.upNext")}
              </p>
              <h2 className="truncate text-xl font-bold">
                {song?.song.headers.title ?? ""}
              </h2>
              <p className="truncate text-white/70">
                {song?.song.headers.artist ?? ""}
              </p>
            </div>
          </div>

          {lineUp.seats.map((seat) => {
            const look = lookOf(seat.memberId);
            const mic = seat.mic;
            const uncalibrated =
              mic === null
                ? undefined
                : lineUp.warnings.find(
                    (w) =>
                      w.code === "notCalibrated" &&
                      w.params.memberId === seat.memberId,
                  );
            return (
              <div
                key={seat.memberId}
                role="group"
                aria-label={nameOf(seat.memberId)}
                className="flex flex-col rounded-[20px] bg-white/10"
              >
                <button
                  type="button"
                  onClick={() => {
                    setOpen(seat.memberId);
                  }}
                  className="flex min-h-15 w-full cursor-pointer items-center gap-2.5 rounded-[20px] p-2.5 text-left outline-none focus-visible:outline-4 focus-visible:outline-yellow"
                >
                  {look && (
                    <span aria-hidden="true">
                      <Avatar
                        name={look.name}
                        avatar={look.avatar}
                        colour={memberOf(seat.memberId)?.colour ?? "cherry"}
                        size={42}
                      />
                    </span>
                  )}
                  <span className="flex min-w-0 grow flex-col">
                    <span className="truncate text-lg font-semibold">
                      {nameOf(seat.memberId)}
                    </span>
                    <span className="truncate text-sm text-white/70">
                      {seatDetails(seat)}
                    </span>
                  </span>
                  {seat.mic === null && <Tag warn>{t("stageTab.noMic")}</Tag>}
                  <Icon name="chevron" className="size-6 shrink-0" />
                </button>
                {uncalibrated && mic && (
                  // "Not calibrated": the seat sings on defaults; the button
                  // opens the usual checklist with this seat's Mic ticked.
                  <div className="flex items-center gap-2.5 px-2.5 pb-2.5">
                    <p className="grow font-semibold text-yellow">
                      {lineUpWarningText(uncalibrated, nameOf)}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        store.send({ type: "openCalibrationFor", mic });
                      }}
                      className="min-h-11 shrink-0 cursor-pointer rounded-full bg-white px-4 font-semibold text-ink shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow"
                    >
                      {t("stage.overlay.calibrateMics")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {lineUp.seats.length < SEATS && (
            <button
              type="button"
              disabled={!free || adding}
              onClick={addSinger}
              className="flex min-h-15 w-full cursor-pointer items-center justify-center gap-2 rounded-[20px] bg-white/10 p-2.5 text-lg font-semibold outline-none focus-visible:outline-4 focus-visible:outline-yellow disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Icon name="plus" className="size-6" />
              {t("stageTab.addSinger")}
            </button>
          )}

          {listed.length > 0 && (
            <ul className="flex flex-col gap-1 py-1 font-semibold text-yellow">
              {listed.map((warning) => {
                const text = lineUpWarningText(
                  warning,
                  nameOf,
                  party?.localMics,
                );
                return <li key={text}>{text}</li>;
              })}
            </ul>
          )}

          <Button
            fill="green"
            className="mt-2 w-full"
            breathing={lineUp.canStart}
            isDisabled={!lineUp.canStart || starting}
            onPress={start}
          >
            {t("stageTab.start")}
          </Button>
        </section>
      )}
      {setup && <CalibrateMicsButton store={store} />}
      {setup && <AvSyncStartButton store={store} />}
      <VolumeControl store={store} />
      <SeatSheet
        store={store}
        myPhoneId={myPhoneId}
        seated={open}
        onSeated={setOpen}
        onClose={() => {
          setOpen(null);
        }}
      />
    </div>
  );
}
