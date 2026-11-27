import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { joinAddress } from "../../joinAddress";
import { JoinCard, JOIN_CARD_HIDDEN_KEY } from "./JoinCard";

/** A fake `localStorage`, empty unless given entries. */
function memoryStorage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  return {
    items,
    storage: () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    }),
  };
}

const HTTPS = joinAddress("https://openstar.example.org/", "http://10.0.0.5");
const PLAIN = joinAddress(null, "http://10.0.0.5:8080");
const LOCAL = joinAddress(null, "http://localhost:8080");

function press(element: Element) {
  act(() => {
    fireEvent.click(element);
  });
}

describe("the join card", () => {
  it("shows the QR code for the join link, the Join code, the address and the hint", () => {
    render(
      <JoinCard
        joinCode="4821"
        join={HTTPS}
        storage={memoryStorage().storage}
      />,
    );
    const qr = screen.getByRole("img", { name: "QR code to join the Party" });
    expect(qr).toHaveAttribute(
      "data-qr-text",
      "https://openstar.example.org/?join=4821",
    );
    // Drawn on the page, not fetched from anywhere.
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M/);

    const code = screen.getByTestId("party-join-code");
    expect(code).toHaveTextContent("4821");
    expect(code.children).toHaveLength(4);
    expect([...code.children].map((box) => box.textContent)).toEqual([
      "4",
      "8",
      "2",
      "1",
    ]);
    expect(screen.getByText("Go to openstar.example.org")).toBeVisible();
    expect(screen.getByText("Pick a song from your phone")).toBeVisible();
    expect(screen.queryByText("Phones can't sing yet")).toBeNull();
  });

  it("shows the plain-http warning in place of the QR code", () => {
    render(
      <JoinCard
        joinCode="4821"
        join={PLAIN}
        storage={memoryStorage().storage}
      />,
    );
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.getByText("Phones can't sing yet")).toBeVisible();
    expect(
      screen.getByText(
        "This Stage was opened over plain http://. Set up HTTPS (see the Caddy example), then reload.",
      ),
    ).toBeVisible();
    // The code and the address stay: typing them still reaches the server.
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("4821");
    expect(screen.getByText("Go to 10.0.0.5:8080")).toBeVisible();
  });

  it("shows the localhost warning instead when the join address is on localhost", () => {
    render(
      <JoinCard
        joinCode="4821"
        join={LOCAL}
        storage={memoryStorage().storage}
      />,
    );
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.getByText("Phones can't sing yet")).toBeVisible();
    expect(
      screen.getByText(
        "Phones and other computers can't reach localhost. Set OPENSTAR_PUBLIC_URL to the server's HTTPS address.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/plain http:\/\//)).toBeNull();
  });

  it("hides to a Join chip and opens again, remembered in the browser's storage", () => {
    const { items, storage } = memoryStorage();
    const view = render(
      <JoinCard joinCode="4821" join={HTTPS} storage={storage} />,
    );
    press(screen.getByRole("button", { name: "Hide" }));

    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    const chip = screen.getByRole("button", { name: "Join · 4821" });
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("4821");
    expect(items.get(JOIN_CARD_HIDDEN_KEY)).toBe("true");
    expect(chip).not.toHaveTextContent("Phones can't sing yet");

    // A reload (a fresh card on the same storage) stays hidden.
    view.unmount();
    render(<JoinCard joinCode="4821" join={HTTPS} storage={storage} />);
    press(screen.getByRole("button", { name: "Join · 4821" }));
    expect(
      screen.getByRole("img", { name: "QR code to join the Party" }),
    ).toBeVisible();
    expect(items.get(JOIN_CARD_HIDDEN_KEY)).toBe("false");
    expect(chip).not.toBeInTheDocument();
  });

  it.each([
    ["plain http", PLAIN],
    ["localhost", LOCAL],
  ])("says on the hidden chip that Phones can't sing, for %s", (_, join) => {
    const { storage } = memoryStorage({ [JOIN_CARD_HIDDEN_KEY]: "true" });
    render(<JoinCard joinCode="4821" join={join} storage={storage} />);
    const chip = screen.getByRole("button", {
      name: "Join · 4821 · Phones can't sing yet",
    });
    expect(chip).toHaveTextContent("Join · 4821 · Phones can't sing yet");
  });

  it("still works when the browser's storage throws", () => {
    const broken = () => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    render(<JoinCard joinCode="4821" join={HTTPS} storage={broken} />);
    press(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("button", { name: "Join · 4821" })).toBeVisible();
  });

  it("offers no Hide when it may not hide (the People overlay)", () => {
    const { storage } = memoryStorage({ [JOIN_CARD_HIDDEN_KEY]: "true" });
    render(
      <JoinCard
        joinCode="4821"
        join={HTTPS}
        storage={storage}
        hideable={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "QR code to join the Party" }),
    ).toBeVisible();
  });
});
