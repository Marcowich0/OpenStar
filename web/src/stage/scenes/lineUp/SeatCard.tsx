// One Line-up seat as a tall white card (v1 spec #55, "Line-up screen"):
// an 18 px top edge in the Player's Party colour, a round × that takes the
// Player off this Song, the big avatar (Who), the name, and the fields as
// cream pills: Mic with its level meter, Voice (duets only) and Difficulty.
// Warnings hang under the card as red bubbles. Cards pop in 80 ms apart.

import { useEffect, useRef, type ReactNode } from "react";

import type { Avatar as AvatarValue } from "../../../generated/Avatar";
import type { LineUpEdit } from "../../../generated/LineUpEdit";
import type { PaletteKey } from "../../../generated/PaletteKey";
import type { Seat } from "../../../generated/Seat";
import { difficultyName, voiceNumber } from "../../../i18n/seatNames";
import { t } from "../../../i18n/t";
import { tokenVar } from "../../../theme/tokens";
import { Avatar } from "../../../ui/Avatar";
import { Icon } from "../../../ui/Icon";
import { nextDifficulty, nextVoice } from "./lineUpView";

/** The gap between two cards popping in. */
const POP_STAGGER_MS = 80;

/** The seat meter's range, in dBFS (as the Mics screen's). */
const METER_FLOOR_DBFS = -60;

const FIELD =
  "flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-full px-[22px] py-3 text-[26px] font-semibold min-h-16";
const FIELD_LABEL = "text-xl font-medium";

function fieldColours(bad: boolean): string {
  return bad ? "bg-warn-bg text-warn-fg" : "bg-cream text-ink";
}

/**
 * A Mic's live level with its Mic threshold line, redrawn every frame from
 * `read` (dBFS, `null` for silence) without a React render. The line is the
 * effective Mic threshold at the current volume (`useMicThresholds`) and
 * shows no number. A Local mic's meter holds the focus: Enter starts the
 * adjust mode (the line turns yellow; ←/→ move it), bound by the scene.
 */
function SeatMeter({
  threshold,
  adjustable,
  adjusting,
  seatIndex,
  label,
  read,
  onBlur,
}: {
  threshold: number;
  adjustable: boolean;
  adjusting: boolean;
  seatIndex: number;
  label: string;
  read: () => number | null;
  onBlur: () => void;
}) {
  const at = (dbfs: number) =>
    `${String(((dbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS) * 100)}%`;
  const meter = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  // The newest `read`, so the frame loop is not restarted on every render.
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const dbfs = reader.current() ?? METER_FLOOR_DBFS;
      const shown = Math.max(METER_FLOOR_DBFS, Math.min(0, dbfs));
      if (fill.current) fill.current.style.width = at(shown);
      meter.current?.setAttribute("aria-valuenow", String(Math.round(shown)));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <span
      ref={meter}
      role="meter"
      aria-label={label}
      aria-valuemin={METER_FLOOR_DBFS}
      aria-valuemax={0}
      aria-valuenow={METER_FLOOR_DBFS}
      tabIndex={adjustable ? -1 : undefined}
      data-stage-focus={adjustable || undefined}
      data-seat-meter={adjustable ? seatIndex : undefined}
      onBlur={onBlur}
      className={`relative block w-full rounded-full bg-white ${adjustable ? "h-5 cursor-pointer" : "h-3"}`}
    >
      <span ref={fill} className="block h-full w-0 rounded-full bg-green" />
      <span
        aria-hidden="true"
        data-threshold-dbfs={threshold}
        data-adjusting={adjusting || undefined}
        className={`absolute -top-1.5 -bottom-1.5 -translate-x-1/2 rounded-full ${
          adjusting
            ? "w-2 bg-yellow shadow-[0_0_0_2px_var(--color-ink)]"
            : "w-1 bg-ink"
        }`}
        style={{ left: at(Math.max(METER_FLOOR_DBFS, Math.min(0, threshold))) }}
      />
    </span>
  );
}

/** A warning's fix: the button that goes with its text. */
export interface WarningFix {
  label: string;
  /** Gets the fix button pressed. */
  onPress: (button: HTMLElement) => void;
  /** Its warning keeps Start greyed. */
  blocksStart: boolean;
}

/** One warning under a seat card: its text, and its fix when it has one. */
export type SeatWarning = string | { text: string; fix: WarningFix };

/**
 * A warning's fix as a white pill. `data-line-up-fix` marks it for a press
 * on the greyed Start, which moves the focus to the first one (the first
 * of a warning that blocks Start, when there is one).
 */
export function FixButton({
  fix,
  className = "",
}: {
  fix: WarningFix;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-line-up-fix={fix.blocksStart ? "blocks" : "other"}
      onClick={(event) => {
        fix.onPress(event.currentTarget);
      }}
      className={`relative cursor-pointer rounded-full bg-white px-5 py-1.5 text-xl font-bold whitespace-nowrap text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow ${className}`}
    >
      {fix.label}
    </button>
  );
}

/**
 * A red warning bubble with a pointer up to the card, and its fix under the
 * text: side by side, a bubble would be wider than a card and its gap, and
 * touch the next seat's.
 */
function WarningBubble({ warning }: { warning: SeatWarning }) {
  const text = typeof warning === "string" ? warning : warning.text;
  return (
    <div className="relative flex animate-pop-in flex-col items-center gap-2.5 rounded-[26px] bg-red px-[22px] py-2.5 text-center text-2xl font-bold whitespace-nowrap text-white shadow-[0_5px_0_var(--color-red-ledge)]">
      <span
        aria-hidden="true"
        className="absolute -top-2 left-1/2 size-5 -translate-x-1/2 rotate-45 rounded-[3px] bg-red"
      />
      <p className="relative">{text}</p>
      {typeof warning !== "string" && <FixButton fix={warning.fix} />}
    </div>
  );
}

export interface SeatCardProps {
  seat: Seat;
  /** The seat's Mic level now, in dBFS (`null`: silence), read every frame. */
  readLevel: () => number | null;
  /** The seat Mic's effective Mic threshold now, dBFS (its meter's line). */
  micThresholdDbfs: number;
  /** A seat with a Mic: its meter holds the focus and has the adjust mode. */
  thresholdAdjustable: boolean;
  /** The adjust mode is on (the line is yellow). */
  adjustingThreshold: boolean;
  /** The meter lost the focus: the adjust mode ends. */
  onMeterBlur: () => void;
  duet: boolean;
  /** The member's name and avatar; empty and `null` while a Profile loads. */
  name: string;
  avatar: AvatarValue | null;
  colour: PaletteKey;
  /** The seat's Mic as text ("Bo's Phone", "none"). */
  micText: string;
  /** No Mic, or a blocked one: the Mic field turns warn colours. */
  micBad: boolean;
  /** The warnings that hang under this card. */
  warnings: readonly SeatWarning[];
  /** Pop-in order: the seat's position. */
  order: number;
  /** The scene's first focus. */
  isDefault: boolean;
  onWho: () => void;
  onMic: () => void;
  /** Sends an edit of this seat (given its seat number). */
  onEdit: (edit: (seat: number) => LineUpEdit) => void;
  /** The open Who or Mic pick list, under its field. */
  whoList?: ReactNode;
  micList?: ReactNode;
}

export function SeatCard({
  seat,
  readLevel,
  micThresholdDbfs,
  thresholdAdjustable,
  adjustingThreshold,
  onMeterBlur,
  duet,
  name,
  avatar,
  colour,
  micText,
  micBad,
  warnings,
  order,
  isDefault,
  onWho,
  onMic,
  onEdit,
  whoList,
  micList,
}: SeatCardProps) {
  return (
    <div
      role="group"
      aria-label={name}
      className="relative flex w-[350px] animate-pop-in flex-col items-center gap-3.5 rounded-card-lg border-t-[18px] bg-white px-[26px] pt-[30px] pb-[26px] shadow-ledge-lg"
      style={{
        borderTopColor: tokenVar(colour),
        animationDelay: `${String(order * POP_STAGGER_MS)}ms`,
      }}
    >
      <button
        type="button"
        aria-label={t("stage.lineUp.remove", { name })}
        onClick={() => {
          onEdit((index) => ({ kind: "removeSeat", seat: index }));
        }}
        className="absolute -top-[30px] -right-3.5 flex size-[58px] cursor-pointer items-center justify-center rounded-full bg-white text-ink-2 shadow-[0_4px_0_var(--color-ledge)]"
      >
        <Icon name="close" className="size-7" />
      </button>
      <span className="relative" data-stage-default={isDefault || undefined}>
        <button
          type="button"
          aria-label={t("stage.lineUp.who", { name })}
          aria-haspopup="menu"
          onClick={onWho}
          className="-mt-1 block cursor-pointer rounded-full"
        >
          {avatar && (
            <Avatar name={name} avatar={avatar} colour={colour} size={150} />
          )}
        </button>
        {whoList}
      </span>
      <span className="text-[44px] leading-none font-bold">{name}</span>
      <span
        className={`relative flex w-full flex-col gap-2 rounded-[32px] px-[22px] pt-1 pb-4 ${fieldColours(micBad)}`}
      >
        <button
          type="button"
          aria-haspopup="menu"
          onClick={onMic}
          className="-mx-[22px] flex min-h-14 cursor-pointer items-center justify-between gap-2.5 rounded-full px-[22px] text-[26px] font-semibold"
        >
          <span className={micBad ? FIELD_LABEL : `${FIELD_LABEL} text-mute`}>
            {t("stage.lineUp.mic")}
          </span>
          <span className="truncate">{micText}</span>
        </button>
        <SeatMeter
          threshold={micThresholdDbfs}
          adjustable={thresholdAdjustable}
          adjusting={adjustingThreshold}
          seatIndex={order}
          read={readLevel}
          label={t("stage.lineUp.micLevel", { name })}
          onBlur={onMeterBlur}
        />
        {micList}
      </span>
      {duet && (
        <button
          type="button"
          data-seat-voice={order}
          onClick={() => {
            onEdit((index) => ({
              kind: "setVoice",
              seat: index,
              voice: nextVoice(seat.voice),
            }));
          }}
          className={`${FIELD} ${fieldColours(false)}`}
        >
          <span className={`${FIELD_LABEL} text-mute`}>
            {t("stage.lineUp.voice")}
          </span>
          {voiceNumber(seat.voice)}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onEdit((index) => ({
            kind: "setDifficulty",
            seat: index,
            difficulty: nextDifficulty(seat.difficulty),
          }));
        }}
        className={`${FIELD} ${fieldColours(false)}`}
      >
        <span className={`${FIELD_LABEL} text-mute`}>
          {t("stage.lineUp.difficulty")}
        </span>
        {difficultyName(seat.difficulty)}
      </button>
      {warnings.length > 0 && (
        <div className="absolute top-full left-1/2 mt-6 flex -translate-x-1/2 flex-col items-center gap-5">
          {warnings.map((warning) => (
            <WarningBubble
              key={typeof warning === "string" ? warning : warning.text}
              warning={warning}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The dashed "Add a singer" spot with a big +. */
export function AddPlayerCard({
  order,
  isDefault,
  onPress,
  children,
}: {
  order: number;
  isDefault: boolean;
  onPress: () => void;
  /** The Who list, when open. */
  children?: ReactNode;
}) {
  return (
    <span
      className="relative block"
      data-stage-default={isDefault || undefined}
    >
      <button
        type="button"
        aria-haspopup="menu"
        onClick={onPress}
        className="flex min-h-[520px] w-[350px] animate-pop-in cursor-pointer flex-col items-center justify-center gap-3.5 rounded-card-lg border-[6px] border-dashed border-ink/20 bg-white/45 text-[34px] font-semibold text-ink-2"
        style={{ animationDelay: `${String(order * POP_STAGGER_MS)}ms` }}
      >
        <span
          aria-hidden="true"
          className="relative flex size-[120px] items-center justify-center rounded-full bg-white shadow-ledge-sm"
        >
          <span className="absolute h-3 w-14 rounded-full bg-ink" />
          <span className="absolute h-14 w-3 rounded-full bg-ink" />
        </span>
        {t("stage.lineUp.addSinger")}
      </button>
      {children}
    </span>
  );
}
