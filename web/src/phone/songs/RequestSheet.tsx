// The Request sheet (v1 spec #49, "Songs tab and the Request sheet"): a
// Song's cover, title, artist and tags, its High score tables, "Who sings
// it?" with the Party members as toggles, and "Add to the Queue" with how
// many Requests are ahead. The same sheet with "Save singers" serves the
// Queue tab's Change singers.

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import {
  profilesQuery,
  songHighScoresQuery,
  songQuery,
} from "../../api/queries";
import type { HighScoreTable } from "../../generated/HighScoreTable";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { Request } from "../../generated/Request";
import type { SongId } from "../../generated/SongId";
import type { UserMessage } from "../../generated/UserMessage";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Cover } from "../../ui/Cover";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { memberLook } from "../memberLook";
import { phoneMember } from "../phonePage";
import { HighScoreTables } from "./HighScoreTables";
import {
  addRequest,
  sameSingers,
  setRequestedPlayers,
  type CommandResult,
} from "./requestCommands";
import { SongTags } from "./SongTags";

/** What the sheet is for: a new Request, or an existing one's singers. */
export type RequestSheetTarget =
  { kind: "add"; songId: SongId } | { kind: "change"; request: Request };

const selectParty = (state: LiveState) => state.stage?.party ?? null;

/** The top total of all the tables, or `null` when none has an entry. */
function topTotal(tables: readonly HighScoreTable[] | undefined) {
  const totals = (tables ?? []).flatMap((table) =>
    table.entries.map((entry) => entry.total),
  );
  return totals.length === 0 ? null : Math.max(...totals);
}

/** Toggles a Party member in or out, keeping the order they were added. */
function toggle(singers: readonly PartyMemberId[], id: PartyMemberId) {
  return singers.includes(id)
    ? singers.filter((s) => s !== id)
    : [...singers, id];
}

export function RequestSheet({
  store,
  target,
  onClose,
}: {
  store: LiveStore;
  /** `null` closes the sheet. */
  target: RequestSheetTarget | null;
  onClose: () => void;
}) {
  // Keep the last target on screen while the sheet slides out.
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) setShown(target);
  const songId =
    shown === null
      ? null
      : shown.kind === "add"
        ? shown.songId
        : shown.request.songId;
  const song = useQuery({
    ...songQuery(songId ?? 0),
    enabled: songId !== null,
  }).data;
  return (
    <Sheet
      label={song?.song.headers.title ?? t("request.loading")}
      isOpen={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {shown !== null && (
        <SheetBody
          key={
            shown.kind === "add"
              ? `add-${String(shown.songId)}`
              : `change-${String(shown.request.requestId)}`
          }
          store={store}
          target={shown}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function SheetBody({
  store,
  target,
  onClose,
}: {
  store: LiveStore;
  target: RequestSheetTarget;
  onClose: () => void;
}) {
  const songId = target.kind === "add" ? target.songId : target.request.songId;
  const song = useQuery(songQuery(songId));
  const highScores = useQuery(songHighScoresQuery(songId));
  const profiles = useQuery(profilesQuery);
  const party = useLive(selectParty, store);
  const me = useLive(phoneMember, store);
  const [singers, setSingers] = useState<PartyMemberId[]>(() =>
    target.kind === "change"
      ? target.request.requestedPlayers
      : me
        ? [me.memberId]
        : [],
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<UserMessage | "noAnswer" | null>(null);
  const whoId = useId();

  if (!song.data)
    return (
      <p role="status" className="py-6 text-center text-ink-2">
        {t("request.loading")}
      </p>
    );

  const { headers, voices } = song.data.song;
  const duet = voices.length > 1;
  const tables = highScores.data?.tables;

  function settle(result: CommandResult) {
    setPending(false);
    if (result.ok) onClose();
    else setProblem(result.reason ?? "noAnswer");
  }

  function submit() {
    if (pending) return;
    setProblem(null);
    if (target.kind === "change") {
      if (sameSingers(singers, target.request.requestedPlayers)) {
        onClose();
        return;
      }
      setPending(true);
      void setRequestedPlayers(store, target.request.requestId, singers).then(
        settle,
      );
      return;
    }
    if (!me) return;
    setPending(true);
    void addRequest(store, songId, singers, me.memberId).then(settle);
  }

  const preparing = target.kind === "add" && song.data.preparing;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3.5">
        <Cover
          src={song.data.media.cover}
          tileColour={song.data.media.tileColour}
          rim={3}
          className="w-21"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-2xl leading-tight font-bold">{headers.title}</h2>
          <p className="text-ink-2">{headers.artist}</p>
          <SongTags
            duet={duet}
            year={headers.year}
            lengthSeconds={song.data.lengthSeconds}
            best={topTotal(tables)}
            className="mt-1"
          />
        </div>
      </div>

      {tables && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold tracking-wide text-mute uppercase">
            {t("request.highScores")}
          </h3>
          <HighScoreTables tables={tables} voices={voices.length} />
        </section>
      )}

      <section
        role="group"
        aria-labelledby={whoId}
        className="flex flex-col gap-2.5"
      >
        <h3
          id={whoId}
          className="text-sm font-semibold tracking-wide text-mute uppercase"
        >
          {t("request.whoSings")}{" "}
          <span className="font-medium tracking-normal normal-case">
            {t(duet ? "request.optionalDuet" : "request.optional")}
          </span>
        </h3>
        {(party?.members ?? []).map((member) => {
          const look = memberLook(member, profiles.data);
          if (!look) return null;
          const on = singers.includes(member.memberId);
          return (
            <button
              key={member.memberId}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setSingers((current) => toggle(current, member.memberId));
              }}
              className={`flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-card-sm bg-white px-3.5 py-2.5 text-left text-lg font-semibold shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow ${on ? "ring-3 ring-ink" : ""}`}
            >
              <span aria-hidden="true">
                <Avatar
                  name={look.name}
                  avatar={look.avatar}
                  colour={member.colour}
                  size={36}
                />
              </span>
              <span className="flex min-w-0 grow items-center gap-1.5">
                <span className="truncate">{look.name}</span>
                {member.memberId === me?.memberId && (
                  <span className="rounded-full bg-cream-2 px-2 text-xs text-ink-2">
                    {t("request.me")}
                  </span>
                )}
                {member.identity.kind === "guest" && (
                  <span className="rounded-full bg-cream-2 px-2 text-xs text-ink-2">
                    {t("request.guest")}
                  </span>
                )}
              </span>
              {on && <Icon name="check" className="size-6 text-ink-2" />}
            </button>
          );
        })}
      </section>

      <div className="flex flex-col gap-2.5">
        {problem !== null && (
          <p role="alert" className="text-center font-semibold text-warn-fg">
            {problem === "noAnswer"
              ? t("request.noAnswer")
              : userMessageText(problem)}
          </p>
        )}
        {preparing && (
          <p className="text-center text-sm text-ink-2">
            {t("request.preparing")}
          </p>
        )}
        <Button
          fill="green"
          className="w-full"
          isDisabled={pending || preparing}
          onPress={submit}
        >
          {target.kind === "add" && <Icon name="plus" className="size-7" />}
          {t(target.kind === "add" ? "request.add" : "request.save")}
        </Button>
        {target.kind === "add" && (
          <p className="text-center text-sm text-mute">
            {t("request.ahead", { count: party?.queue.length ?? 0 })}
          </p>
        )}
      </div>
    </div>
  );
}
