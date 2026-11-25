import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";

import { profilesQuery } from "../api/queries";
import type { PhoneId } from "../generated/PhoneId";
import { t, type MessageKey } from "../i18n/t";
import type { IconName } from "../icons/icons";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { Avatar } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { TopBar } from "./Logo";
import { memberLook } from "./memberLook";
import { MeButton, type MeActions } from "./people/MeSheet";
import { PeopleTab } from "./people/PeopleTab";
import { phoneMember } from "./phonePage";
import { PhoneToasts } from "./PhoneToasts";
import {
  defaultTab,
  queueCount,
  REMOTE_TABS,
  statusStrip,
  type RemoteTab,
} from "./remoteFrame";
import { SongsTab } from "./songs/SongsTab";
import { StageTab } from "./stage/StageTab";
import { StatusStrip } from "./StatusStrip";

/** Each tab's label and icon, in `REMOTE_TABS` order. */
const TABS = {
  songs: { label: "remote.songs", icon: "music" },
  queue: { label: "remote.queue", icon: "list" },
  stage: { label: "remote.stage", icon: "tv" },
  people: { label: "remote.people", icon: "people" },
} as const satisfies Record<RemoteTab, { label: MessageKey; icon: IconName }>;

const selectParty = (state: LiveState) => state.stage?.party ?? null;

function isRemoteTab(key: unknown): key is RemoteTab {
  return REMOTE_TABS.some((tab) => tab === key);
}

/**
 * The Remote's frame (v1 spec #49, "The Remote frame"): the top bar with the
 * logo and this Phone's own avatar, the four tabs at the bottom with the
 * Queue's badge, the status strip above them, and the toasts at the top. It
 * opens on the Stage tab while a Line-up waits, on Songs otherwise. The
 * Songs tab is `SongsTab`, the Stage tab `StageTab`, the People tab
 * `PeopleTab`, and the avatar opens the Me sheet (`MeButton`); the Queue
 * tab's contents come with a later ticket.
 */
export function Remote({
  store,
  phoneId,
  me,
}: {
  store: LiveStore;
  /** This Phone's own id: its Mic is "This phone" on the Stage tab. */
  phoneId: PhoneId;
  me?: MeActions;
}) {
  const member = useLive(phoneMember, store);
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery);
  const look = member ? memberLook(member, profiles.data) : null;
  // Picked once, when the Remote opens; after that the person picks.
  const [tab, setTab] = useState<RemoteTab>(() =>
    defaultTab(selectParty(store.getSnapshot())),
  );
  const strip = statusStrip(party, tab);
  const count = queueCount(party);

  return (
    <Tabs
      selectedKey={tab}
      onSelectionChange={(key) => {
        if (isRemoteTab(key)) setTab(key);
      }}
      className="flex min-h-dvh flex-col"
    >
      <PhoneToasts store={store} />
      <TopBar>
        {member && look && me ? (
          <MeButton store={store} member={member} look={look} me={me} />
        ) : member && look ? (
          <Avatar
            name={look.name}
            avatar={look.avatar}
            colour={member.colour}
            size={44}
          />
        ) : null}
      </TopBar>
      {REMOTE_TABS.map((id) => (
        <TabPanel key={id} id={id} className="grow px-5 pb-4 outline-none">
          {id === "songs" && <SongsTab store={store} />}
          {id === "stage" && <StageTab store={store} myPhoneId={phoneId} />}
          {id === "people" && <PeopleTab store={store} />}
        </TabPanel>
      ))}
      <div className="sticky bottom-0 flex flex-col">
        {strip && (
          <StatusStrip
            strip={strip}
            onOpenStage={() => {
              setTab("stage");
            }}
          />
        )}
        <TabList
          aria-label={t("remote.tabs")}
          className="flex bg-white px-1.5 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom,0px))] shadow-[0_-4px_0_var(--color-ledge)]"
        >
          {REMOTE_TABS.map((id) => {
            const { label, icon } = TABS[id];
            const badge = id === "queue" && count > 0;
            return (
              <Tab
                key={id}
                id={id}
                {...(badge
                  ? { "aria-label": t("remote.queueWithCount", { count }) }
                  : {})}
                className="group relative flex flex-1 cursor-pointer flex-col items-center gap-1 rounded-card-sm py-1.5 text-sm font-semibold text-mute outline-none data-focus-visible:outline-4 data-focus-visible:outline-yellow data-selected:text-ink"
              >
                <Icon
                  name={icon}
                  className="size-7 transition-transform group-data-selected:scale-115 group-data-selected:text-red"
                />
                {t(label)}
                {badge && (
                  <span className="absolute top-0 left-[56%] rounded-full bg-red px-1.5 text-xs font-semibold text-white">
                    {count}
                  </span>
                )}
              </Tab>
            );
          })}
        </TabList>
      </div>
    </Tabs>
  );
}
