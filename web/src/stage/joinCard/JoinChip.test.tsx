// The Join chip on the Line-up and results (#250), inside the real Stage
// frame: the live Join code, People on a press, and nothing while a Song
// plays.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { profilesQuery, serverInfoQuery, songsQuery } from "../../api/queries";
import { createQueryClient } from "../../api/queryClient";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { LocalMicsContext, NO_LOCAL_MICS } from "../../mics/LocalMics";
import { t } from "../../i18n/t";
import { SCENES } from "../frame/sceneComponents";
import { StageFrame } from "../frame/StageFrame";
import { songResults } from "../scenes/results/testResults";
import { PauseMenu } from "../scenes/sing/PauseMenu";

// The Stage applies the OpenStar volume to its audio chain; jsdom has none.
vi.mock("../playback/stageAudio", () => ({
  stageAudio: () => ({ chain: () => ({ setVolume: () => {} }) }),
}));

const HTTPS = "https://openstar.example.org";
const PLAIN = "http://192.168.1.20:8080";

const lineUpParty = (joinCode = "4821"): PartySnapshot => ({
  partyId: "p",
  stageId: "main",
  joinCode,
  startedAtMs: 1,
  members: [],
  phones: [],
  queue: [
    {
      requestId: 1,
      kind: "song",
      songId: 10,
      requestedPlayers: [],
      adder: null,
    },
  ],
  head: 1,
  lineUp: {
    requestId: 1,
    duet: false,
    seats: [],
    canStart: false,
    warnings: [],
  },
  playing: null,
  results: null,
  localMics: [],
});

const singing = (): PartySnapshot => ({
  ...lineUpParty(),
  playing: { requestId: 1, songId: 10, paused: true },
});

const results = (): PartySnapshot => ({
  ...lineUpParty(),
  queue: [],
  head: null,
  lineUp: null,
  results: songResults([]),
});

function setup(snapshot: PartySnapshot, publicUrl: string = HTTPS) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const queries = createQueryClient();
  queries.setQueryData(profilesQuery.queryKey, []);
  queries.setQueryData(songsQuery().queryKey, {
    songs: [],
    filters: {
      languages: [],
      genres: [],
      years: [],
      editions: [],
      creators: [],
      duet: [],
      hasVideo: [],
      length: null,
    },
  });
  queries.setQueryData(serverInfoQuery.queryKey, {
    version: "dev",
    schemaVersion: 1,
    libraryReadOnly: null,
    publicUrl,
  });
  render(
    <QueryClientProvider client={queries}>
      <LocalMicsContext value={NO_LOCAL_MICS}>
        <StageFrame
          store={store}
          // The sing screen's video and canvases need more than jsdom has;
          // its pause menu stands in for it.
          scenes={{
            ...SCENES,
            sing: { component: () => <PauseMenu onControl={() => {}} /> },
          }}
        />
      </LocalMicsContext>
    </QueryClientProvider>,
  );
  const send = (party: PartySnapshot) => {
    act(() => {
      handlers?.onMessage({
        type: "liveState",
        stageId: "main",
        party,
        isStage: true,
      });
    });
  };
  act(() => {
    handlers?.onConnection("open");
  });
  send(snapshot);
  return { send };
}

const chip = () => screen.queryByRole("button", { name: /^Join · / });

const scene = () =>
  document.querySelector("[data-stage-frame]")?.getAttribute("data-scene");

describe("the Join chip", () => {
  it("shows the Join code on the Line-up", () => {
    setup(lineUpParty());
    expect(scene()).toBe("lineUp");
    expect(chip()).toHaveAccessibleName("Join · 4821");
    expect(chip()).toHaveTextContent("Join · 4821");
  });

  it("says Phones can't sing yet without HTTPS", () => {
    setup(lineUpParty(), PLAIN);
    expect(chip()).toHaveAccessibleName("Join · 4821 · Phones can't sing yet");
    expect(chip()).toHaveTextContent("Join · 4821 · Phones can't sing yet");
  });

  it("shows the new Party's code at once", () => {
    const { send } = setup(lineUpParty());
    send(lineUpParty("1357"));
    expect(chip()).toHaveAccessibleName("Join · 1357");
  });

  it("opens People when pressed", () => {
    setup(lineUpParty());
    const pressed = chip();
    if (!pressed) throw new Error("no chip");
    fireEvent.click(pressed);
    expect(
      screen.getByRole("dialog", { name: t("stage.overlay.people") }),
    ).toBeInTheDocument();
  });

  it("opens People on Enter", () => {
    setup(lineUpParty());
    const pressed = chip();
    if (!pressed) throw new Error("no chip");
    act(() => {
      pressed.focus();
      fireEvent.keyDown(pressed, { key: "Enter" });
      fireEvent.keyUp(pressed, { key: "Enter" });
    });
    expect(
      screen.getByRole("dialog", { name: t("stage.overlay.people") }),
    ).toBeInTheDocument();
  });

  it("is gone on the sing screen and its pause menu, and back on the results", () => {
    const { send } = setup(lineUpParty());
    expect(chip()).toBeInTheDocument();
    send(singing());
    expect(scene()).toBe("sing");
    expect(screen.getByRole("dialog", { name: "Paused" })).toBeInTheDocument();
    expect(chip()).toBeNull();
    send(results());
    expect(scene()).toBe("results");
    expect(chip()).toHaveAccessibleName("Join · 4821");
  });
});
