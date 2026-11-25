import { describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "./liveClient";
import { createLiveStore } from "./liveStore";

function start() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const server = (message: ServerMessage) => {
    handlers?.onMessage(message);
  };
  const connection = (state: "open" | "reconnecting") => {
    handlers?.onConnection(state);
  };
  return { store, server, connection, sent };
}

describe("live store", () => {
  it("applies server messages and tells subscribers", () => {
    const { store, server, connection } = start();
    const listener = vi.fn();
    store.subscribe(listener);

    connection("open");
    server({ type: "liveState", stageId: "main", placeholder: "Hi" });

    expect(store.getSnapshot().connection).toBe("open");
    expect(store.getSnapshot().stage?.placeholder).toBe("Hi");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the same snapshot when nothing changed", () => {
    const { store, server } = start();
    const before = store.getSnapshot();
    server({ type: "changed", topics: ["placeholder"] });
    expect(store.getSnapshot()).toBe(before);
  });

  it("tells the listeners of each topic a change notice names", () => {
    const { store, server } = start();
    const placeholder = vi.fn();
    const unsubscribe = store.onChanged("placeholder", placeholder);

    server({ type: "changed", topics: ["placeholder"] });
    expect(placeholder).toHaveBeenCalledTimes(1);

    unsubscribe();
    server({ type: "changed", topics: ["placeholder"] });
    expect(placeholder).toHaveBeenCalledTimes(1);
  });

  it("sends through the client", () => {
    const { store, sent } = start();
    store.send({ type: "setPlaceholder", text: "Yo" });
    expect(sent).toEqual([{ type: "setPlaceholder", text: "Yo" }]);
  });
});
