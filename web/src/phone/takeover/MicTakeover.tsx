// The mic takeover (v1 spec #49, "Mic takeover"; ticket #167): while this
// Phone is the Mic of a seat in the Line-up it replaces the Remote, the whole
// screen in the seated Player's Party colour. A large avatar sits in a ring
// that pulses with the sung level; chips say whose mic it is and the Voice
// (duets only) and Difficulty; "Queue & controls" opens the Remote on top.
// The step comes from `micTakeover`. There are no lyrics, no Notes and no
// Song time here: the progress is the Stage's position reports and the Score
// is the seat's running total at each Line end.
//
// The mic check (Mic is on) shows the level against this Phone's Mic
// threshold, with a slider to set it by hand; "Show mic diagnostics" opens
// the diagnostics while the mic is on (`MicCheck.tsx`).
//
// Mic blocked is a full-screen card naming the reason, with Try again; mic
// lost says the Song kept going, with a big Sing again (#176). After the Song
// (#176) is the Player's own result until Done.

import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from "react-aria-components";

import { profilesQuery, songQuery } from "../../api/queries";
import { rankTitle } from "../../i18n/rankTitles";
import type { RequestId } from "../../generated/RequestId";
import { Icon } from "../../ui/Icon";
import type { Difficulty } from "../../generated/Difficulty";
import { difficultyName, voiceNumber } from "../../i18n/seatNames";
import { t, type MessageKey } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { useLiveState } from "../../live/useLive";
import { tokenVar } from "../../theme/tokens";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Score } from "../../ui/Score";
import { Sheet } from "../../ui/Sheet";
import { memberLook } from "../memberLook";
import type { MicBlockedReason, PhoneMic } from "../mic/phoneMic";
import {
  usePhoneMicSettings,
  type PhoneMicSettings,
} from "../mic/usePhoneMicSettings";
import { Progress } from "../onStage/PlayingCard";
import { setMyDifficulty } from "../people/memberRequests";
import { PhoneToasts } from "../PhoneToasts";
import { MicDiagnostics, ThresholdMeter } from "./MicCheck";
import { editLineUp, startSong } from "../stage/lineUpCommands";
import {
  levelOf,
  type AfterTheSong,
  type MicTakeover as AnyTakeover,
  type SeatTakeover as Takeover,
} from "./micTakeover";

const BLOCKED_TEXT = {
  permissionRefused: "phoneMic.blocked.permissionRefused",
  noHttps: "phoneMic.blocked.noHttps",
  notOpened: "phoneMic.blocked.notOpened",
} as const satisfies Record<MicBlockedReason, MessageKey>;

/** The card's headline: the reason in a few words. */
const BLOCKED_REASON = {
  permissionRefused: "phoneTakeover.blockedReason.permissionRefused",
  noHttps: "phoneTakeover.blockedReason.noHttps",
  notOpened: "phoneTakeover.blockedReason.notOpened",
} as const satisfies Record<MicBlockedReason, MessageKey>;

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

function isDifficulty(key: unknown): key is Difficulty {
  return DIFFICULTIES.some((d) => d === key);
}

export interface MicTakeoverProps {
  store: LiveStore;
  takeover: AnyTakeover;
  mic: PhoneMic;
  /** This Phone's own Party member: the Difficulty chip sets theirs like the Me sheet. */
  myMemberId: number | null;
  /** "Queue & controls": the Remote on top. */
  onOpenRemote: () => void;
  /** Done on the After the Song screen, for the Request sung. */
  onDone: (requestId: RequestId) => void;
  /** `?perf` on the Phone page: readings per second and the detector's cost. */
  diagnostics?: boolean;
}

export function MicTakeover({ takeover, ...props }: MicTakeoverProps) {
  if (takeover.step === "after")
    return (
      <AfterTheSongScreen
        store={props.store}
        after={takeover}
        onDone={props.onDone}
      />
    );
  if (takeover.step === "blocked")
    return (
      <BlockedCard
        store={props.store}
        takeover={takeover}
        mic={props.mic}
        onOpenRemote={props.onOpenRemote}
      />
    );
  return <SeatScreen takeover={takeover} {...props} />;
}

function SeatScreen({
  store,
  takeover,
  mic,
  myMemberId,
  onOpenRemote,
  diagnostics = false,
}: Omit<MicTakeoverProps, "takeover" | "onDone"> & { takeover: Takeover }) {
  const profiles = useQuery(profilesQuery).data;
  const song = useQuery(songQuery(takeover.songId)).data;
  const state = useLiveState(store);
  const member = state.stage?.party?.members.find(
    (m) => m.memberId === takeover.memberId,
  );
  const look = member ? memberLook(member, profiles) : null;
  const name = look?.name ?? "";
  const title = song?.song.headers.title ?? "";
  const { step } = takeover;
  const seatMic = takeover.seat.mic;
  const settings = usePhoneMicSettings(
    store,
    seatMic?.kind === "phone" ? seatMic.phoneId : "",
  );

  return (
    <main
      aria-label={t("phoneTakeover.label")}
      data-testid="mic-takeover"
      data-step={step}
      className="flex min-h-dvh flex-col items-center gap-5 px-5 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] text-white"
      style={{ backgroundColor: tokenVar(takeover.colour) }}
    >
      <PhoneToasts store={store} />
      <div className="flex flex-wrap justify-center gap-2">
        <span className="rounded-full bg-white/20 px-4 py-1.5 text-lg font-semibold">
          {t("phoneTakeover.micChip", { name })}
        </span>
        <DifficultyChip
          store={store}
          takeover={takeover}
          myMemberId={myMemberId}
        />
      </div>

      <LevelRing mic={mic}>
        {look && member && (
          <Avatar
            name={look.name}
            avatar={look.avatar}
            colour={member.colour}
            size={168}
          />
        )}
      </LevelRing>

      <div className="flex w-full grow flex-col items-center gap-4 text-center">
        <Step
          store={store}
          takeover={takeover}
          mic={mic}
          settings={settings}
          name={name}
          title={title}
          lengthSeconds={song?.lengthSeconds ?? null}
        />
      </div>

      <Button fill="white" className="w-full" onPress={onOpenRemote}>
        {t("phoneTakeover.queueAndControls")}
      </Button>
      {diagnostics && (step === "micOn" || step === "singing") && (
        <Diagnostics mic={mic} />
      )}
      {(step === "micOn" || step === "singing") && (
        <MicDiagnostics
          mic={mic}
          settings={settings}
          openAtFirst={diagnostics}
        />
      )}
    </main>
  );
}

function Step({
  store,
  takeover,
  mic,
  settings,
  name,
  title,
  lengthSeconds,
}: {
  store: LiveStore;
  takeover: Takeover;
  mic: PhoneMic;
  settings: PhoneMicSettings;
  name: string;
  title: string;
  lengthSeconds: number | null;
}) {
  const [starting, setStarting] = useState(false);
  switch (takeover.step) {
    case "seated":
    case "opening":
      return (
        <>
          <h1 className="text-4xl font-bold">
            {takeover.started
              ? t("phoneTakeover.singIt")
              : t("phoneTakeover.youreUp", { name })}
          </h1>
          <p className="text-xl">
            {takeover.started
              ? title
              : t("phoneTakeover.isNext", { song: title })}
          </p>
          <Button
            fill="green"
            size="big"
            className="mt-auto w-full"
            isDisabled={takeover.step === "opening"}
            onPress={() => {
              // A mic lost before Start reopens like Sing again.
              if (mic.getSnapshot().state === "lost") mic.singAgain();
              else mic.turnOn();
            }}
          >
            {takeover.step === "opening"
              ? t("phoneMic.opening")
              : t("phoneMic.turnOn")}
          </Button>
        </>
      );
    case "micOn":
      return (
        <>
          <h1 className="text-4xl font-bold">{t("phoneMic.on")}</h1>
          <p className="text-xl">{t("phoneTakeover.singANote")}</p>
          <ThresholdMeter
            mic={mic}
            settings={settings}
            started={takeover.started}
          />
          <p className="text-lg text-white/80">{t("phoneTakeover.keepOpen")}</p>
          <Button
            fill="green"
            size="big"
            className="mt-auto w-full"
            breathing={takeover.canStart}
            isDisabled={!takeover.canStart || starting}
            onPress={() => {
              if (starting) return;
              setStarting(true);
              void startSong(store, takeover.requestId).then(() => {
                setStarting(false);
              });
            }}
          >
            {t("stageTab.start")}
          </Button>
        </>
      );
    case "singing":
      return (
        <>
          <h1 className="text-5xl font-bold">{t("phoneTakeover.singIt")}</h1>
          <p className="text-2xl font-semibold">{title}</p>
          <div className="flex flex-col items-center">
            <span className="text-lg text-white/80">
              {t("phoneTakeover.score")}
            </span>
            <span data-testid="takeover-score">
              <Score
                value={takeover.score ?? 0}
                className="text-6xl font-bold"
              />
            </span>
          </div>
          <div className="w-full">
            <Progress store={store} fallbackLength={lengthSeconds} />
          </div>
          <p className="mt-auto text-lg text-white/80">
            {t("phoneTakeover.screenOn")}
          </p>
        </>
      );
    case "blocked":
      // The full-screen card (`BlockedCard`) shows instead.
      return null;
    case "lost":
      return (
        <>
          <Icon name="mic-off" className="size-12" />
          <h1 className="text-4xl font-bold">{t("phoneMic.stopped")}</h1>
          <p className="text-xl">{t("phoneMic.stoppedBody")}</p>
          <Button
            fill="green"
            size="big"
            className="mt-auto w-full px-6!"
            breathing
            onPress={() => {
              mic.singAgain();
            }}
          >
            {t("phoneMic.singAgain")}
          </Button>
        </>
      );
  }
}

/**
 * Mic blocked: a full-screen card naming the reason, with Try again (the same
 * open path as the first tap). Meanwhile the mic reports the seat blocked, so
 * the Stage and every Remote warn "<name>'s mic is blocked".
 */
function BlockedCard({
  store,
  takeover,
  mic,
  onOpenRemote,
}: {
  store: LiveStore;
  takeover: Takeover;
  mic: PhoneMic;
  onOpenRemote: () => void;
}) {
  const reason = takeover.blocked ?? "notOpened";
  return (
    <main
      aria-label={t("phoneTakeover.label")}
      data-testid="mic-takeover"
      data-step="blocked"
      className="flex min-h-dvh flex-col gap-3 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] text-white"
      style={{ backgroundColor: tokenVar(takeover.colour) }}
    >
      <PhoneToasts store={store} />
      <section
        aria-labelledby="mic-blocked-title"
        className="flex grow flex-col items-center gap-5 rounded-card bg-ink px-5 pt-10 pb-5 text-center shadow-ledge"
      >
        <span className="grid size-24 place-items-center rounded-full bg-white/10">
          <Icon name="mic-off" className="size-12" />
        </span>
        <h1 id="mic-blocked-title" className="text-3xl font-bold">
          {t("phoneTakeover.blocked")}
        </h1>
        <p className="text-2xl font-semibold text-yellow">
          {t(BLOCKED_REASON[reason])}
        </p>
        <p className="text-lg text-white/80">{t(BLOCKED_TEXT[reason])}</p>
        <Button
          fill="green"
          size="big"
          className="mt-auto w-full px-6!"
          onPress={() => {
            mic.turnOn();
          }}
        >
          {t("phoneMic.tryAgain")}
        </Button>
      </section>
      <Button fill="white" className="w-full" onPress={onOpenRemote}>
        {t("phoneTakeover.queueAndControls")}
      </Button>
    </main>
  );
}

/**
 * After the Song: the Player's own Score, Rank title and "New high score!"
 * badge, or "Ended early" when this Player did not finish, until Done.
 */
function AfterTheSongScreen({
  store,
  after,
  onDone,
}: {
  store: LiveStore;
  after: AfterTheSong;
  onDone: (requestId: RequestId) => void;
}) {
  const song = useQuery(songQuery(after.songId)).data;
  const { result } = after;
  return (
    <main
      aria-label={t("phoneTakeover.after")}
      data-testid="mic-takeover"
      data-step="after"
      className="flex min-h-dvh flex-col items-center gap-5 px-5 pt-8 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] text-center text-white"
      style={{ backgroundColor: tokenVar(after.colour) }}
    >
      <PhoneToasts store={store} />
      <p className="text-xl font-semibold">{song?.song.headers.title ?? ""}</p>
      <Avatar
        name={result.name}
        avatar={result.avatar}
        colour={result.colour}
        size={144}
      />
      <h1 className="text-2xl font-semibold">{t("phoneTakeover.yourScore")}</h1>
      <span data-testid="after-score">
        <Score
          value={result.total}
          className="text-7xl leading-none font-bold"
        />
      </span>
      <p className="text-3xl font-bold">{rankTitle(result.rankTitleBand)}</p>
      {result.newHighScore && (
        <p className="rounded-full bg-yellow px-5 py-2 text-xl font-bold text-ink shadow-ledge-sm">
          {t("stageTab.newHighScore")}
        </p>
      )}
      {result.unfinished && (
        <p className="rounded-full bg-ink/40 px-5 py-2 text-xl font-semibold">
          {t("stageTab.endedEarly")}
        </p>
      )}
      <Button
        fill="white"
        size="big"
        className="mt-auto w-full px-6!"
        onPress={() => {
          onDone(after.requestId);
        }}
      >
        {t("phoneTakeover.done")}
      </Button>
    </main>
  );
}

/**
 * Voice (duets only) and Difficulty. Until Start it opens Easy, Medium and
 * Hard; it sets the same value as the Me sheet (the seat's Difficulty).
 */
function DifficultyChip({
  store,
  takeover,
  myMemberId,
}: {
  store: LiveStore;
  takeover: Takeover;
  myMemberId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const { seat } = takeover;
  const label = takeover.duet
    ? t("phoneTakeover.voiceDifficulty", {
        voice: voiceNumber(seat.voice),
        difficulty: difficultyName(seat.difficulty),
      })
    : difficultyName(seat.difficulty);
  const chip = "rounded-full bg-white/20 px-4 py-1.5 text-lg font-semibold";
  if (takeover.started) return <span className={chip}>{label}</span>;

  function choose(difficulty: Difficulty) {
    if (seat.memberId === myMemberId) {
      setMyDifficulty(store, difficulty);
    } else {
      const index = takeover.seatIndex;
      void editLineUp(store, takeover.requestId, {
        kind: "setDifficulty",
        seat: index,
        difficulty,
      });
    }
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        aria-label={t("phoneTakeover.changeDifficulty", { current: label })}
        className={`${chip} cursor-pointer outline-none focus-visible:outline-4 focus-visible:outline-yellow`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
      <Sheet
        label={t("phoneTakeover.difficulty")}
        isOpen={open}
        onOpenChange={setOpen}
      >
        <RadioGroup
          value={seat.difficulty}
          onChange={(key) => {
            if (isDifficulty(key)) choose(key);
          }}
          className="flex flex-col gap-2"
        >
          <Label className="text-lg font-semibold">
            {t("phoneTakeover.difficulty")}
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {DIFFICULTIES.map((d) => (
              <RadioField key={d} value={d}>
                <RadioButton className="flex min-h-14 cursor-pointer items-center justify-center rounded-card-sm bg-white text-xl font-semibold shadow-ledge-sm outline-none data-focus-visible:outline-6 data-focus-visible:outline-yellow data-selected:bg-ink data-selected:text-white">
                  {difficultyName(d)}
                </RadioButton>
              </RadioField>
            ))}
          </div>
        </RadioGroup>
      </Sheet>
    </>
  );
}

const hundredths = (ms: number) => Math.round(ms * 100) / 100;

/** The small readout: readings per second and the detector's cost per window. */
function Diagnostics({ mic }: { mic: PhoneMic }) {
  const { readingsPerSecond, detector } = useSyncExternalStore(
    mic.subscribe,
    mic.getSnapshot,
  );
  return (
    <p
      aria-label={t("phoneMic.diagnostics")}
      data-testid="phone-mic-diagnostics"
      className="flex flex-wrap justify-center gap-x-3 text-sm text-white/70 tabular-nums"
    >
      <span data-readings-per-second={readingsPerSecond}>
        {t("phoneMic.readingsPerSecond", { count: readingsPerSecond })}
      </span>
      <span>
        {detector
          ? t("phoneMic.detectorCost", {
              p50: hundredths(detector.p50Ms),
              p95: hundredths(detector.p95Ms),
            })
          : t("phoneMic.detectorMeasuring")}
      </span>
    </p>
  );
}

/** Writes the sung level into `--level` on `ref`'s element, outside React. */
function useLevel(mic: PhoneMic) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      mic.onLevel((dbfs) => {
        ref.current?.style.setProperty("--level", String(levelOf(dbfs)));
      }),
    [mic],
  );
  return ref;
}

/** The avatar's ring: it grows and brightens with the sung level. */
function LevelRing({ mic, children }: { mic: PhoneMic; children: ReactNode }) {
  const ref = useLevel(mic);
  return (
    <div
      ref={ref}
      data-testid="level-ring"
      className="relative grid size-56 place-items-center"
      style={{ "--level": "0" } as CSSProperties}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full border-8 border-white/80 transition-transform duration-100 motion-reduce:transition-none"
        style={{
          transform: "scale(calc(0.85 + var(--level) * 0.15))",
          opacity: "calc(0.35 + var(--level) * 0.65)",
        }}
      />
      {children}
    </div>
  );
}
