// The motion pass (#260): the focus ring, the buttons, the overlays and the
// toasts on the Stage and the Phone move by the motion tokens of
// `tokens.css`, which fall back to fades (`tokens.test.ts`). They move only
// `scale`, `translate` and `opacity`, never the layout.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { profilesQuery } from "../api/queries";
import { createQueryClient } from "../api/queryClient";
import type { PartySnapshot } from "../generated/PartySnapshot";
import { createLiveStore, type LiveStore } from "../live/liveStore";
import { PhoneToasts } from "../phone/PhoneToasts";
import stageFrameCss from "../stage/frame/stageFrame.css?raw";
import { press, renderOverlays } from "../stage/overlays/testOverlay";
import { StageToasts } from "../stage/toasts/StageToasts";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Sheet } from "../ui/Sheet";

const EMPTY_PARTY: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
  localMics: [],
};

/** The declarations of every stylesheet rule whose selector ends `selectorEnd`. */
function rule(css: string, selectorEnd: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) =>
      (selector ?? "")
        .replace(/\s+/g, " ")
        .replace(/\s+\)/g, ")")
        .trim()
        .endsWith(selectorEnd),
    )
    .map(([, , body]) => body ?? "");
  expect(found.length, selectorEnd).toBeGreaterThan(0);
  return found.join("\n");
}

describe("the Stage's focus ring", () => {
  it("bounces when it lands", () => {
    expect(rule(stageFrameCss, ":focus")).toMatch(
      /animation:\s*var\(--animate-focus-bounce\)/,
    );
  });

  it("squashes whatever is pressed and springs it back", () => {
    const pressed = rule(stageFrameCss, "[data-stage-pressed])");
    expect(pressed).toMatch(/scale:\s*var\(--motion-press-scale\)/);
    const resting = rule(stageFrameCss, ":is(button, [data-stage-focus])");
    expect(resting).toMatch(/scale var\(--motion-press\) var\(--ease-spring\)/);
  });

  it("moves nothing but scale and opacity", () => {
    const css = stageFrameCss.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, property] of css.matchAll(/^\s*([\w-]+):/gm)) {
      expect([
        "transition",
        "outline",
        "box-shadow",
        "scale",
        "animation",
      ]).toContain(property);
    }
  });
});

describe("a button", () => {
  it("squashes on press with the press tokens", () => {
    render(<Button>Sing!</Button>);
    const classes = screen.getByRole("button").classList;
    expect(classes).toContain("data-pressed:scale-(--motion-press-scale)");
    expect(classes).toContain("duration-(--motion-press)");
  });
});

describe("an overlay", () => {
  it("springs in on the Stage, and its ghost springs out", () => {
    const { container } = renderOverlays(EMPTY_PARTY);
    press("q");
    const overlay = container.querySelector("[data-overlay]");
    const modal = within(overlay as HTMLElement).getByRole("dialog");
    expect(modal).toHaveClass(
      "animate-overlay-in",
      "in-data-leaving:animate-overlay-out",
    );
    expect(screen.getByTestId("overlay-veil")).toHaveClass(
      "animate-fade-in",
      "in-data-leaving:animate-veil-out",
    );
  });

  it("springs a dialog in and out by the overlay tokens", () => {
    render(
      <Dialog title="Sure?" isOpen onOpenChange={() => undefined}>
        <p>Text</p>
      </Dialog>,
    );
    const modal = screen.getByRole("dialog").parentElement;
    expect(modal).toHaveClass(
      "duration-(--motion-spring)",
      "data-entering:scale-(--motion-overlay-scale)",
      "data-exiting:scale-(--motion-overlay-scale)",
      "data-exiting:duration-(--motion-exit)",
      "data-exiting:ease-exit",
    );
  });

  it("raises a Phone sheet by the sheet token", () => {
    render(
      <Sheet label="Me" isOpen onOpenChange={() => undefined}>
        <p>Text</p>
      </Sheet>,
    );
    const modal = screen.getByRole("dialog").parentElement;
    expect(modal).toHaveClass(
      "duration-(--motion-spring)",
      "data-entering:translate-y-(--motion-sheet-rise)",
      "data-exiting:translate-y-(--motion-sheet-rise)",
    );
  });
});

describe("a toast", () => {
  function withToast(ui: (store: LiveStore) => ReactNode) {
    const store = createLiveStore(() => ({
      send: () => true,
      close: () => undefined,
    }));
    const queries = createQueryClient();
    queries.setQueryData(profilesQuery.queryKey, []);
    render(
      <QueryClientProvider client={queries}>{ui(store)}</QueryClientProvider>,
    );
    act(() => {
      store.showStageToast({ code: "soundOutputChanged" });
    });
    return screen.getByRole("listitem");
  }

  it("drops in on the Stage", () => {
    const toast = withToast((store) => (
      <StageToasts store={store} duringSong={false} />
    ));
    expect(toast).toHaveClass("animate-toast-in");
  });

  it("drops in on the Phone", () => {
    const toast = withToast((store) => <PhoneToasts store={store} />);
    expect(toast).toHaveClass("animate-toast-in");
  });
});

describe("Enter on the Stage", () => {
  it("presses the focused element until it is let go", () => {
    renderOverlays(EMPTY_PARTY);
    const focused = document.activeElement;
    expect(focused?.matches("button, [data-stage-focus]")).toBe(true);
    act(() => {
      fireEvent.keyDown(focused ?? document.body, { key: "Enter" });
    });
    expect(focused).toHaveAttribute("data-stage-pressed");
    act(() => {
      fireEvent.keyUp(focused ?? document.body, { key: "Enter" });
    });
    expect(focused).not.toHaveAttribute("data-stage-pressed");
  });
});
