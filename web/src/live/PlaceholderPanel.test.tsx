import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";
import type { LiveClientOptions } from "./liveClient";
import { createLiveStore } from "./liveStore";
import { PlaceholderPanel } from "./PlaceholderPanel";

function fakeStore() {
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
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
  return { store, sent, live };
}

describe("PlaceholderPanel", () => {
  it("shows the connection and the placeholder every browser shares", () => {
    const { store, live } = fakeStore();
    render(<PlaceholderPanel store={store} />);
    expect(screen.getByTestId("live-connection")).toHaveTextContent(
      "connecting",
    );

    live((h) => {
      h.onConnection("open");
      h.onMessage({ type: "liveState", stageId: "main", placeholder: "Hi" });
    });
    expect(screen.getByTestId("live-connection")).toHaveTextContent("open");
    expect(screen.getByTestId("placeholder")).toHaveTextContent("Hi");

    live((h) => {
      h.onMessage({
        type: "placeholderChanged",
        stageId: "main",
        placeholder: "Bye",
      });
    });
    expect(screen.getByTestId("placeholder")).toHaveTextContent("Bye");
  });

  it("keeps showing the last state while it reconnects", () => {
    const { store, live } = fakeStore();
    render(<PlaceholderPanel store={store} />);
    live((h) => {
      h.onConnection("open");
      h.onMessage({ type: "liveState", stageId: "main", placeholder: "Hi" });
      h.onConnection("reconnecting");
    });
    expect(screen.getByTestId("live-connection")).toHaveTextContent(
      "reconnecting",
    );
    expect(screen.getByTestId("placeholder")).toHaveTextContent("Hi");
  });

  it("sends a change over the WebSocket", () => {
    const { store, sent, live } = fakeStore();
    render(<PlaceholderPanel store={store} />);
    live((h) => {
      h.onConnection("open");
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Hello room" },
    });
    fireEvent.submit(screen.getByRole("textbox"));
    expect(sent).toEqual([{ type: "setPlaceholder", text: "Hello room" }]);
  });

  it("shows a rejection by its code", () => {
    const { store, live } = fakeStore();
    render(<PlaceholderPanel store={store} />);
    live((h) => {
      h.onMessage({
        type: "rejected",
        reason: { code: "placeholderTooLong", params: { maxLength: 1000 } },
      });
    });
    expect(screen.getByTestId("rejection")).toHaveTextContent(
      "placeholderTooLong",
    );
  });
});
