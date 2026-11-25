import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../api/queryClient";
import { profilesQuery } from "../../api/queries";
import type { ChangeEvent } from "../../generated/ChangeEvent";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { ServerMessage } from "../../generated/ServerMessage";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import type { SceneDefinition } from "../frame/sceneComponents";
import { StageFrame } from "../frame/StageFrame";
import type { SceneId } from "../frame/scenes";
import { TOAST_LEAVE_MS, TOAST_STAY_MS } from "./toastQueue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const party: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [
    {
      memberId: 1,
      identity: { kind: "profile", profileId: 7 },
      colour: "tangerine",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
  ],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
};

const bo: Profile = {
  id: 7,
  name: "Bo",
  avatar: { kind: "builtIn", key: "cat" },
  favouriteColour: "cherry",
  lastDifficulty: "medium",
  createdAt: 1,
  lastSungAt: null,
};

// Blank scenes: these tests look at the toasts only.
const Blank = () => null;
const blankScenes: Record<SceneId, SceneDefinition> = {
  songBrowser: { component: Blank },
  lineUp: { component: Blank },
  sing: { component: Blank, fullScreen: true },
  results: { component: Blank },
  stageMoved: { component: Blank },
};

const movedUp = (title: string): ChangeEvent => ({
  actor: { kind: "member", memberId: 1 },
  event: {
    code: "requestMovedUp",
    params: { requestId: 1, songId: 1, title },
  },
});

function setup(scene: SceneId = "songBrowser") {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const queryClient = createQueryClient();
  queryClient.setQueryData(profilesQuery.queryKey, [bo]);
  render(
    <QueryClientProvider client={queryClient}>
      <StageFrame
        store={store}
        takeStageBack={() => {}}
        scenes={blankScenes}
        chooseScene={() => scene}
      />
    </QueryClientProvider>,
  );
  const send = (message: ServerMessage) => {
    act(() => {
      handlers?.onMessage(message);
    });
  };
  act(() => {
    handlers?.onConnection("open");
  });
  send({ type: "liveState", stageId: "main", party, isStage: true });
  const change = (change: ChangeEvent) => {
    send({ type: "partyChanged", party, change });
  };
  return { change };
}

const toastList = () => screen.getByRole("status", { name: "Party changes" });
const shown = () =>
  within(toastList())
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("toasts on the Stage", () => {
  it("shows a Remote's change with that Party member's avatar, names in bold", () => {
    const { change } = setup();
    change(movedUp("Africa"));
    const toast = within(toastList()).getByRole("listitem");
    expect(toast).toHaveTextContent("Bo moved Africa up");
    expect(within(toast).getByText("Bo").tagName).toBe("B");
    expect(within(toast).getByText("Africa").tagName).toBe("B");
    expect(
      within(toast).getByRole("img", { hidden: true }),
    ).toHaveAccessibleName("Bo");
  });

  it("shows no toast for a change made on the Stage itself", () => {
    const { change } = setup();
    change({
      actor: { kind: "stage" },
      event: { code: "partyStarted", params: { joinCode: "4821" } },
    });
    expect(shown()).toEqual([]);
  });

  it("shows at most three, oldest at the top", () => {
    const { change } = setup();
    for (const title of ["Africa", "Shallow", "Toxic", "Hello"]) {
      change(movedUp(title));
    }
    expect(shown()).toEqual([
      "Bo moved Shallow up",
      "Bo moved Toxic up",
      "Bo moved Hello up",
    ]);
  });

  it("stays about 4 s, then fades up and is gone", () => {
    const { change } = setup();
    change(movedUp("Africa"));
    wait(TOAST_STAY_MS - 1);
    expect(shown()).toEqual(["Bo moved Africa up"]);
    wait(1);
    expect(within(toastList()).getByRole("listitem")).toHaveAttribute(
      "data-leaving",
    );
    wait(TOAST_LEAVE_MS);
    expect(shown()).toEqual([]);
  });

  it("stacks from about 150 px below the top, or about 90 px during a Song", () => {
    setup();
    expect(toastList()).toHaveStyle({ paddingTop: "150px" });
  });

  it("stacks higher during a Song, above the lanes", () => {
    setup("sing");
    expect(toastList()).toHaveStyle({ paddingTop: "90px" });
  });
});
