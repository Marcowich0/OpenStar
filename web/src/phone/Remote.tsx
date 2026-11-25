import { useQuery } from "@tanstack/react-query";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";

import { profilesQuery } from "../api/queries";
import { t, type MessageKey } from "../i18n/t";
import type { IconName } from "../icons/icons";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { Avatar } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { TopBar } from "./Logo";
import { memberLook } from "./memberLook";
import { phoneMember } from "./phonePage";

/** The Remote's four tabs, in order. */
const TABS = [
  { id: "songs", label: "remote.songs", icon: "music" },
  { id: "queue", label: "remote.queue", icon: "list" },
  { id: "stage", label: "remote.stage", icon: "tv" },
  { id: "people", label: "remote.people", icon: "people" },
] as const satisfies readonly {
  id: string;
  label: MessageKey;
  icon: IconName;
}[];

/**
 * The Remote's frame (v1 spec #49, "The Remote frame"): the top bar with the
 * logo and this Phone's own avatar, and the four tabs at the bottom. The
 * tabs' contents, the status strip and the Me sheet come with later tickets.
 */
export function Remote({ store }: { store: LiveStore }) {
  const member = useLive(phoneMember, store);
  const profiles = useQuery(profilesQuery);
  const look = member ? memberLook(member, profiles.data) : null;

  return (
    <Tabs defaultSelectedKey="songs" className="flex min-h-dvh flex-col">
      <TopBar>
        {member && look ? (
          <Avatar
            name={look.name}
            avatar={look.avatar}
            colour={member.colour}
            size={44}
          />
        ) : null}
      </TopBar>
      {TABS.map((tab) => (
        <TabPanel key={tab.id} id={tab.id} className="grow px-5 outline-none" />
      ))}
      <TabList
        aria-label={t("remote.tabs")}
        className="sticky bottom-0 flex bg-white px-1.5 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom,0px))] shadow-[0_-4px_0_var(--color-ledge)]"
      >
        {TABS.map((tab) => (
          <Tab
            key={tab.id}
            id={tab.id}
            className="group flex flex-1 cursor-pointer flex-col items-center gap-1 rounded-card-sm py-1.5 text-sm font-semibold text-mute outline-none data-focus-visible:outline-4 data-focus-visible:outline-yellow data-selected:text-ink"
          >
            <Icon
              name={tab.icon}
              className="size-7 transition-transform group-data-selected:scale-115 group-data-selected:text-red"
            />
            {t(tab.label)}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
