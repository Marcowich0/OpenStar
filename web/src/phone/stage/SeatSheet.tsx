// The seat sheet (v1 spec #49, "Stage tab"): opened by tapping a seat of the
// waiting Line-up. Who (the Party members' avatars; picking one who sits in
// another seat moves them), Mic, Voice (duets only), Difficulty and "Take
// <name> off this Song". Every choice is one `editLineUp`; the sheet shows
// what the server's next Party state says.

import { useEffect, useId, useState, type ReactNode } from "react";

import type { Difficulty } from "../../generated/Difficulty";
import type { LineUpEdit } from "../../generated/LineUpEdit";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PhoneId } from "../../generated/PhoneId";
import type { Seat } from "../../generated/Seat";
import type { SeatVoice } from "../../generated/SeatVoice";
import type { UserMessage } from "../../generated/UserMessage";
import { userMessageText } from "../../i18n/serverText";
import { DIFFICULTY_NAME_KEYS, voiceNumber } from "../../i18n/seatNames";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { Avatar } from "../../ui/Avatar";
import { Sheet } from "../../ui/Sheet";
import type { CommandResult } from "../songs/requestCommands";
import { editLineUp } from "./lineUpCommands";
import { seatMicOptions } from "./seatMics";
import { useLineUp } from "./useLineUp";

const DIFFICULTIES = Object.keys(DIFFICULTY_NAME_KEYS) as Difficulty[];
const VOICES: SeatVoice[] = ["p1", "p2"];

export interface SeatSheetProps {
  store: LiveStore;
  myPhoneId: PhoneId;
  /** The member whose seat the sheet shows; `null` closes it. */
  seated: PartyMemberId | null;
  /** Someone else now sits in the seat: the sheet follows the seat. */
  onSeated: (memberId: PartyMemberId) => void;
  onClose: () => void;
}

export function SeatSheet({
  store,
  myPhoneId,
  seated,
  onSeated,
  onClose,
}: SeatSheetProps) {
  const data = useLineUp(store);
  const { lineUp, nameOf } = data;
  const index =
    seated === null || lineUp === null
      ? -1
      : lineUp.seats.findIndex((s) => s.memberId === seated);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | "noAnswer" | null>(null);
  // The last seat shown, kept on screen while the sheet slides out and while
  // an edit waits for the server.
  const seat = index === -1 ? undefined : lineUp?.seats[index];
  const current = seat ? { index, seat } : null;
  const [shown, setShown] = useState(current);
  if (
    current &&
    !pending &&
    (shown?.index !== current.index || shown.seat !== current.seat)
  )
    setShown(current);

  // The seat went (taken off, or the Line-up is gone): close.
  const gone = seated !== null && index === -1 && !pending;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const isOpen = seated !== null && !gone;
  const view = isOpen ? (current ?? shown) : shown;

  // A press while an edit waits for the server does nothing. The buttons
  // stay enabled so the focus stays in the sheet (and Esc still closes it).
  function send(edit: LineUpEdit, then?: () => void) {
    if (pending || !lineUp) return;
    setProblem(null);
    setPending(true);
    void editLineUp(store, lineUp.requestId, edit).then(
      (result: CommandResult) => {
        if (result.ok) then?.();
        else setProblem(result.reason ?? "noAnswer");
        setPending(false);
      },
    );
  }

  return (
    <Sheet
      label={view ? nameOf(view.seat.memberId) : t("stageTab.seat")}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {view && lineUp && (
        <SeatBody
          data={data}
          myPhoneId={myPhoneId}
          index={view.index}
          seat={view.seat}
          problem={problem}
          send={send}
          onSeated={onSeated}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function SeatBody({
  data,
  myPhoneId,
  index,
  seat,
  problem,
  send,
  onSeated,
  onClose,
}: {
  data: ReturnType<typeof useLineUp>;
  myPhoneId: PhoneId;
  index: number;
  seat: Seat;
  problem: UserMessage | "noAnswer" | null;
  send: (edit: LineUpEdit, then?: () => void) => void;
  onSeated: (memberId: PartyMemberId) => void;
  onClose: () => void;
}) {
  const { party, lineUp, song, localMics, members, memberOf, lookOf, nameOf } =
    data;
  if (!party || !lineUp) return null;
  const look = lookOf(seat.memberId);
  const name = nameOf(seat.memberId);
  const mics = seatMicOptions({
    party,
    lineUp,
    seat: index,
    myPhoneId,
    localMics,
    nameOf,
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3.5">
        {look && (
          <span aria-hidden="true">
            <Avatar
              name={look.name}
              avatar={look.avatar}
              colour={memberOf(seat.memberId)?.colour ?? "cherry"}
              size={52}
            />
          </span>
        )}
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-2xl leading-tight font-bold">{name}</h2>
          <p className="text-ink-2">
            {t("stageTab.seatFor", {
              number: index + 1,
              song: song?.song.headers.title ?? "",
            })}
          </p>
        </div>
      </div>

      <Group label={t("stageTab.who")}>
        <div className="flex flex-wrap gap-2.5">
          {members.map((member) => {
            const memberLook = lookOf(member.memberId);
            if (!memberLook) return null;
            const here = member.memberId === seat.memberId;
            return (
              <button
                key={member.memberId}
                type="button"
                aria-label={memberLook.name}
                aria-pressed={here}
                onClick={() => {
                  if (here) return;
                  send(
                    {
                      kind: "setWho",
                      seat: index,
                      who: { kind: "member", memberId: member.memberId },
                    },
                    () => {
                      onSeated(member.memberId);
                    },
                  );
                }}
                className={`cursor-pointer rounded-full outline-offset-2 focus-visible:outline-4 focus-visible:outline-yellow ${here ? "outline-3 outline-ink" : ""}`}
              >
                <Avatar
                  name={memberLook.name}
                  avatar={memberLook.avatar}
                  colour={member.colour}
                  size={48}
                />
              </button>
            );
          })}
        </div>
      </Group>

      <Group label={t("stageTab.mic")}>
        <div className="flex flex-col gap-2.5">
          {mics.map((option) => (
            <button
              key={
                option.mic.kind === "phone"
                  ? `phone-${option.mic.phoneId}`
                  : `local-${option.mic.localMicId}`
              }
              type="button"
              aria-pressed={option.current}
              disabled={option.inUse || option.unavailable}
              onClick={() => {
                if (!option.current)
                  send({ kind: "setMic", seat: index, mic: option.mic });
              }}
              className={`flex min-h-14 w-full items-center gap-3 rounded-[20px] bg-white px-3.5 py-2.5 text-left text-lg font-semibold shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow disabled:cursor-not-allowed ${option.inUse || option.unavailable ? "opacity-45" : "cursor-pointer"} ${option.current ? "ring-3 ring-ink" : ""}`}
            >
              <span className="grow truncate">{option.name}</span>
              {option.inUse && <Tag>{t("stageTab.inUse")}</Tag>}
              {!option.inUse && option.unavailable && (
                <Tag>{t("stageTab.unplugged")}</Tag>
              )}
            </button>
          ))}
        </div>
      </Group>

      {lineUp.duet && (
        <Group label={t("stageTab.voice")}>
          <Segments>
            {VOICES.map((voice) => (
              <Segment
                key={voice}
                on={seat.voice === voice}
                onPress={() => {
                  send({ kind: "setVoice", seat: index, voice });
                }}
              >
                {t("stageTab.voiceNumber", { voice: voiceNumber(voice) })}
              </Segment>
            ))}
          </Segments>
        </Group>
      )}

      <Group label={t("stageTab.difficulty")}>
        <Segments>
          {DIFFICULTIES.map((difficulty) => (
            <Segment
              key={difficulty}
              on={seat.difficulty === difficulty}
              onPress={() => {
                send({ kind: "setDifficulty", seat: index, difficulty });
              }}
            >
              {t(DIFFICULTY_NAME_KEYS[difficulty])}
            </Segment>
          ))}
        </Segments>
      </Group>

      {problem !== null && (
        <p role="alert" className="text-center font-semibold text-warn-fg">
          {problem === "noAnswer"
            ? t("request.noAnswer")
            : userMessageText(problem)}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          send({ kind: "removeSeat", seat: index }, onClose);
        }}
        className="min-h-14 w-full cursor-pointer rounded-full bg-white text-lg font-semibold text-red shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow"
      >
        {t("stageTab.takeOff", { name })}
      </button>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section role="group" aria-labelledby={id} className="flex flex-col gap-2">
      <h3
        id={id}
        className="text-sm font-semibold tracking-wide text-mute uppercase"
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

function Segments({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-1 rounded-full bg-cream-2 p-1">{children}</div>
  );
}

function Segment({
  on,
  onPress,
  children,
}: {
  on: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        if (!on) onPress();
      }}
      className={`min-h-11 flex-1 cursor-pointer rounded-full font-semibold outline-none focus-visible:outline-4 focus-visible:outline-yellow ${on ? "bg-white shadow-ledge-sm" : ""}`}
    >
      {children}
    </button>
  );
}

export function Tag({
  warn = false,
  children,
}: {
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${warn ? "bg-warn-bg text-warn-fg" : "bg-cream-2 text-ink-2"}`}
    >
      {children}
    </span>
  );
}
