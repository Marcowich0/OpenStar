import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "./liveClient";
import type { LiveState } from "./liveState";
import { createLiveStore, type LiveStore } from "./liveStore";
import { useLive } from "./useLive";

function start() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  return {
    store,
    server: (message: ServerMessage) => {
      act(() => handlers?.onMessage(message));
    },
    connection: (connection: "open" | "reconnecting") => {
      act(() => handlers?.onConnection(connection));
    },
  };
}

const selectConnection = (state: LiveState) => state.connection;
const selectStage = (state: LiveState) => state.stage;

type Rendered = (slice: "connection" | "stage") => void;

function ConnectionProbe({
  store,
  rendered,
}: {
  store: LiveStore;
  rendered: Rendered;
}) {
  const connection = useLive(selectConnection, store);
  rendered("connection");
  return <p data-testid="connection">{connection}</p>;
}

function StageProbe({
  store,
  rendered,
}: {
  store: LiveStore;
  rendered: Rendered;
}) {
  const stage = useLive(selectStage, store);
  rendered("stage");
  return <p data-testid="stage">{stage?.placeholder ?? ""}</p>;
}

describe("useLive", () => {
  it("re-renders a component when the slice it reads changes, and not for another slice", () => {
    const { store, server, connection } = start();
    const renders = { connection: 0, stage: 0 };
    const rendered: Rendered = (slice) => {
      renders[slice] += 1;
    };
    render(
      <>
        <ConnectionProbe store={store} rendered={rendered} />
        <StageProbe store={store} rendered={rendered} />
      </>,
    );
    expect(renders).toEqual({ connection: 1, stage: 1 });

    connection("open");
    expect(screen.getByTestId("connection")).toHaveTextContent("open");
    expect(renders).toEqual({ connection: 2, stage: 1 });

    server({ type: "liveState", stageId: "main", placeholder: "Hi" });
    expect(screen.getByTestId("stage")).toHaveTextContent("Hi");
    expect(renders).toEqual({ connection: 2, stage: 2 });

    server({ type: "pong", nonce: 1 });
    expect(renders).toEqual({ connection: 2, stage: 2 });
  });
});
