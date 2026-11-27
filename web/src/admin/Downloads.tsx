// The Admin area's Downloads section, its browse half (v1 spec #47, #193):
// an instant search over OpenStar's mirror of USDB's song list, sorted by
// views or rating, with an "In Library" badge on songs the Library already
// has and each song's cover (fetched through the server, cached there). Its
// notices say how to set the USDB credentials, that the login failed, how
// far the mirror's first fill is, and why the last mirror run failed.
// Opening the section asks for a fresh mirror (the server updates it only
// when it is more than a day old); a button starts a full refetch. Nothing
// here needs the Admin PIN. Tapping a result opens the video picker
// (`VideoPicker`); pressing Download there starts a Download (#195), which
// is guarded: without an Unlock the PIN pad opens then, and on a read-only
// Library the button is disabled with the notice that says why. The list
// of Downloads above the search (`DownloadList`, #196) follows each one
// live and cancels it without a PIN. The Stage shows this same section in its
// Downloads overlay (`stage/overlays/DownloadsOverlay.tsx`).

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import {
  Button as AriaButton,
  Input,
  SearchField,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";

import { api } from "../api/api";
import {
  usdbMirrorQuery,
  usdbSongsQuery,
  usdbStatusQuery,
} from "../api/queries";
import type { UsdbMirrorStatus } from "../generated/UsdbMirrorStatus";
import { useGuardedAction } from "../guarded/useGuardedAction";
import { browserStorage } from "../live/browserLive";
import { phoneId } from "../live/phoneId";
import type { UsdbSearchQuery } from "../generated/UsdbSearchQuery";
import type { UsdbSong } from "../generated/UsdbSong";
import type { UsdbSort } from "../generated/UsdbSort";
import type { UsdbState } from "../generated/UsdbState";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import { OwnerFold } from "../ui/OwnerFold";
import { Cover } from "../ui/Cover";
import { Icon } from "../ui/Icon";
import type { LiveStore } from "../live/liveStore";
import { AdminSection } from "./AdminSection";
import { DownloadList } from "./DownloadList";
import { VideoPicker } from "./VideoPicker";

function searchQuery(search: string, sort: UsdbSort): UsdbSearchQuery {
  const words = search.trim();
  return words === "" ? { sort } : { search: words, sort };
}

export function Downloads({
  store,
  showTitle = true,
  foldOwnerDetail = false,
}: {
  /** The live store the list follows; the browser's own by default. */
  store?: LiveStore | undefined;
  /** Shows the section's heading; the Stage's overlay has its own. */
  showTitle?: boolean;
  /**
   * On the Stage: a USDB setup problem shows one friendly line, its variable
   * names folded "For the owner". The Admin area shows them in full.
   */
  foldOwnerDetail?: boolean;
} = {}) {
  const status = useQuery(usdbStatusQuery).data?.state;
  const mirror = useQuery(usdbMirrorQuery).data;
  useRefreshOnOpen();

  return (
    <AdminSection
      title={t("admin.downloads")}
      showTitle={showTitle}
      writesLibrary
      notices={
        <UsdbNotices
          status={status}
          mirror={mirror}
          foldOwnerDetail={foldOwnerDetail}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <DownloadList store={store} />
        <MirrorLine status={status} mirror={mirror} />
        <Search />
      </div>
    </AdminSection>
  );
}

/** Asks the server for a fresh mirror once, when the section opens. */
function useRefreshOnOpen() {
  const queryClient = useQueryClient();
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    api("POST /api/usdb/mirror/refresh").then(
      (answer) => {
        queryClient.setQueryData(usdbMirrorQuery.queryKey, answer);
      },
      () => {
        // The mirror's status query shows what there is; nothing to add.
      },
    );
  }, [queryClient]);
}

interface UsdbProps {
  status: UsdbState | undefined;
  mirror: UsdbMirrorStatus | undefined;
}

const NOTICE =
  "rounded-card-sm bg-warn-bg px-5 py-3 text-lg font-semibold text-warn-fg";

function Notice({ children }: { children: string }) {
  return <p className={NOTICE}>{children}</p>;
}

/** A setup problem on the Stage: one friendly line, the detail folded. */
function FoldedNotice({ line, detail }: { line: string; detail: string }) {
  return (
    <div className={`flex flex-col gap-2 ${NOTICE}`}>
      <p>{line}</p>
      <OwnerFold className="text-base">
        <p className="text-lg font-medium">{detail}</p>
      </OwnerFold>
    </div>
  );
}

/** The Stage's friendly line for the login states whose text is for the owner. */
function stageLine(status: UsdbState | undefined): string | null {
  switch (status) {
    case "credentialsMissing":
      return t("admin.downloads.stage.notSetUp");
    case "loginFailed":
      return t("admin.downloads.stage.loginFailed");
    case undefined:
    case "loggedIn":
    case "checking":
    case "unreachable":
    case "gaveUp":
      return null;
  }
}

function loginNotice(status: UsdbState | undefined): string | null {
  switch (status) {
    case undefined:
    case "loggedIn":
      return null;
    case "credentialsMissing":
      return t("admin.downloads.credentialsMissing");
    case "checking":
      return t("admin.downloads.checking");
    case "loginFailed":
      return t("admin.downloads.loginFailed");
    case "unreachable":
      return t("admin.downloads.unreachable");
    case "gaveUp":
      return t("admin.downloads.gaveUp");
  }
}

function UsdbNotices({
  status,
  mirror,
  foldOwnerDetail,
}: UsdbProps & { foldOwnerDetail: boolean }) {
  const login = loginNotice(status);
  const line = foldOwnerDetail ? stageLine(status) : null;
  const filling = mirror?.state.type === "filling" ? mirror.state : null;
  return (
    <>
      {login === null ? null : line === null ? (
        <Notice>{login}</Notice>
      ) : (
        <FoldedNotice line={line} detail={login} />
      )}
      {filling === null || mirror === undefined ? null : (
        <p
          role="status"
          className="rounded-card-sm bg-white px-5 py-3 text-lg font-semibold text-ink shadow-ledge-sm"
        >
          {filling.percent === null
            ? t("admin.downloads.fillingStarted", { count: mirror.songs })
            : t("admin.downloads.filling", {
                count: mirror.songs,
                percent: filling.percent,
              })}
        </p>
      )}
      {mirror?.lastFailure == null ? null : (
        <Notice>
          {t("admin.downloads.lastFailure", {
            reason: userMessageText(mirror.lastFailure),
          })}
        </Notice>
      )}
    </>
  );
}

function mirrorText(mirror: UsdbMirrorStatus): string | null {
  const count = mirror.songs;
  switch (mirror.state.type) {
    case "unavailable":
    case "filling":
      return null;
    case "empty":
      return t("admin.downloads.mirror.empty");
    case "refreshing":
      return t(
        mirror.state.full
          ? "admin.downloads.mirror.refetching"
          : "admin.downloads.mirror.updating",
      );
    case "incomplete":
      return t("admin.downloads.mirror.incomplete", { count });
    case "fresh":
      return t("admin.downloads.mirror.fresh", { count });
    case "stale":
      return t("admin.downloads.mirror.stale", { count });
  }
}

/** Where the mirror stands, and the full refetch by hand (no PIN). */
function MirrorLine({ status, mirror }: UsdbProps) {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const running =
    mirror?.state.type === "filling" || mirror?.state.type === "refreshing";
  const disabled =
    starting || running || status === undefined || status !== "loggedIn";

  const refetch = async () => {
    setStarting(true);
    setFailed(false);
    try {
      const answer = await api("POST /api/usdb/mirror/refetch");
      queryClient.setQueryData(usdbMirrorQuery.queryKey, answer);
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  const text = failed
    ? t("admin.downloads.refetchFailed")
    : mirror === undefined
      ? null
      : mirrorText(mirror);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p role="status" className="min-w-0 grow font-semibold text-ink">
        {text}
      </p>
      <AriaButton
        isDisabled={disabled}
        onPress={() => {
          void refetch();
        }}
        className="inline-flex min-h-12 shrink-0 cursor-pointer items-center rounded-full bg-white px-5 text-lg font-semibold text-ink shadow-ledge outline-none transition-transform duration-200 data-disabled:cursor-default data-disabled:opacity-50 data-focus-visible:outline-6 data-focus-visible:outline-yellow data-pressed:scale-95"
      >
        {t("admin.downloads.refetch")}
      </AriaButton>
    </div>
  );
}

const SORTS: readonly UsdbSort[] = ["views", "rating"];

function isSort(key: unknown): key is UsdbSort {
  return SORTS.some((sort) => sort === key);
}

function Search() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<UsdbSort>("views");
  const query = searchQuery(useDeferredValue(search), sort);
  const found = useQuery({
    ...usdbSongsQuery(query),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          aria-label={t("admin.downloads.search")}
          value={search}
          onChange={setSearch}
          className="flex h-13 min-w-0 grow basis-60 items-center gap-2.5 rounded-full bg-white px-4.5 ring-2 ring-ledge"
        >
          <Icon name="search" className="size-5.5 shrink-0 text-ink-2" />
          <Input
            // The Stage's focus ring reaches it in the Downloads overlay.
            data-stage-focus=""
            placeholder={t("admin.downloads.search")}
            autoComplete="off"
            className="min-w-0 grow bg-transparent text-lg text-ink outline-none placeholder:text-mute [&::-webkit-search-cancel-button]:hidden"
          />
        </SearchField>
        <ToggleButtonGroup
          aria-label={t("admin.downloads.sort")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[sort]}
          onSelectionChange={(keys) => {
            const [key] = [...keys];
            if (isSort(key)) setSort(key);
          }}
          className="flex shrink-0 rounded-full bg-passed p-1"
        >
          {SORTS.map((key) => (
            <ToggleButton
              key={key}
              id={key}
              className="rounded-full px-4 py-2 text-base font-semibold text-ink-2 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ink data-[selected]:bg-white data-[selected]:text-ink data-[selected]:shadow-ledge-sm"
            >
              {t(
                key === "views"
                  ? "admin.downloads.sort.views"
                  : "admin.downloads.sort.rating",
              )}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      {found.data ? (
        found.data.songs.length === 0 ? (
          <p className="py-4 text-center">
            {t(
              query.search === undefined
                ? "admin.downloads.empty"
                : "admin.downloads.none",
            )}
          </p>
        ) : (
          <>
            <ul
              aria-label={t("admin.downloads.list")}
              className="flex flex-col gap-3"
            >
              {found.data.songs.map((song) => (
                <UsdbSongRow key={song.usdbId} song={song} />
              ))}
            </ul>
            {found.data.total > found.data.songs.length ? (
              <p className="text-center text-base text-ink-2">
                {t("admin.downloads.showing", {
                  shown: found.data.songs.length,
                  total: found.data.total,
                })}
              </p>
            ) : null}
          </>
        )
      ) : (
        <p role="status" className="py-4 text-center">
          {t(
            found.isError
              ? "admin.downloads.failed"
              : "admin.downloads.loading",
          )}
        </p>
      )}
    </>
  );
}

/**
 * One USDB song: its cover, title, artist, rating and views, and the badge.
 * Tapping it opens the video picker.
 */
function UsdbSongRow({ song }: { song: UsdbSong }) {
  const [picking, setPicking] = useState(false);
  const [started, setStarted] = useState(false);
  // The video the guarded action sends: set just before it runs.
  const chosen = useRef("");
  const start = useGuardedAction(
    () =>
      api("POST /api/downloads", {
        body: {
          usdbId: song.usdbId,
          videoUrl: chosen.current,
          browser: phoneId(browserStorage()),
        },
      }),
    { writesLibrary: true },
  );
  return (
    <li className="min-w-0">
      <AriaButton
        onPress={() => {
          setPicking(true);
        }}
        className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-card-sm text-left outline-none data-focus-visible:outline-6 data-focus-visible:outline-yellow data-pressed:bg-white"
      >
        <Cover
          src={song.cover}
          song={{
            id: song.usdbId,
            title: song.title,
            tileColour: song.tileColour,
          }}
          rim={3}
          lazy
          className="w-14 shrink-0"
        />
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <span className="truncate text-lg leading-tight font-semibold text-ink">
            {song.title}
          </span>
          <span className="truncate text-sm text-ink-2">{song.artist}</span>
          <span className="flex flex-wrap items-center gap-x-3 text-sm text-ink-2">
            <span>{t("admin.downloads.rating", { rating: song.rating })}</span>
            <span>{t("admin.downloads.views", { count: song.views })}</span>
          </span>
        </div>
        {song.inLibrary ? (
          <span className="shrink-0 rounded-full bg-green px-2.5 py-0.5 text-sm font-semibold text-white">
            {t("admin.downloads.inLibrary")}
          </span>
        ) : started ? (
          <span role="status" className="shrink-0 text-sm font-semibold">
            {t("admin.downloads.started")}
          </span>
        ) : null}
      </AriaButton>
      <VideoPicker
        song={song}
        isOpen={picking}
        onOpenChange={setPicking}
        isDownloadDisabled={start.isDisabled}
        onDownload={async (url) => {
          chosen.current = url;
          const outcome = await start.run();
          if (outcome.kind === "done") {
            setPicking(false);
            setStarted(true);
          }
        }}
      />
      {start.dialog}
    </li>
  );
}
