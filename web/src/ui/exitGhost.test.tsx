// The exit ghost (#260): a closed overlay leaves a lifeless copy that plays
// its exit animation, then goes.

import { act, render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_GHOST_MAX_MS, useExitGhost } from "./exitGhost";

function Overlay() {
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  return (
    <div ref={ref} data-overlay="queue" data-testid="overlay">
      <div role="dialog" aria-modal aria-labelledby="h" data-stage-layer="2">
        <h2 id="h">Queue</h2>
        <button type="button">Close</button>
        <video />
      </div>
    </div>
  );
}

function Frame({ open }: { open: boolean }) {
  return (
    <div data-testid="frame">
      <span data-testid="before" />
      {open && <Overlay />}
      <span data-testid="after" />
    </div>
  );
}

interface FakeAnimation {
  finished: Promise<unknown>;
  effect: { getComputedTiming: () => { endTime: number } };
}

/** Web Animations as far as the ghost uses them; `finish` ends the finite ones. */
function stubAnimations({ infinite = false } = {}) {
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const animations: FakeAnimation[] = [
    { finished, effect: { getComputedTiming: () => ({ endTime: 250 }) } },
  ];
  if (infinite) {
    animations.push({
      finished: new Promise(() => undefined),
      effect: { getComputedTiming: () => ({ endTime: Infinity }) },
    });
  }
  Element.prototype.getAnimations = () => animations as unknown as Animation[];
  return {
    finish: async () => {
      finish();
      await act(() => Promise.resolve());
    },
  };
}

const ghosts = () => document.querySelectorAll("[data-leaving]");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).getAnimations;
});

describe("useExitGhost", () => {
  it("leaves a lifeless copy in the overlay's place when it closes", async () => {
    stubAnimations();
    const { getByTestId, rerender } = render(<Frame open />);
    rerender(<Frame open={false} />);
    await act(() => Promise.resolve());
    const [ghost] = ghosts();
    expect(ghost).toBeDefined();
    expect(ghost?.previousElementSibling).toBe(getByTestId("before"));
    expect(ghost?.nextElementSibling).toBe(getByTestId("after"));
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost).toHaveAttribute("inert");
    expect(ghost?.textContent).toContain("Queue");
    // Nothing in it can be found, focused or played as the real thing.
    expect(
      ghost?.querySelector("[id], [role], [aria-modal], video"),
    ).toBeNull();
    expect(
      ghost?.querySelector("[data-overlay], [data-testid], [data-stage-layer]"),
    ).toBeNull();
    expect(ghost).not.toHaveAttribute("data-overlay");
    expect(ghost).not.toHaveAttribute("data-testid");
  });

  it("goes once its exit animation has finished", async () => {
    const animations = stubAnimations({ infinite: true });
    const { rerender } = render(<Frame open />);
    rerender(<Frame open={false} />);
    await act(() => Promise.resolve());
    expect(ghosts()).toHaveLength(1);
    // An endless animation inside (a breathing button) is not waited for.
    await animations.finish();
    expect(ghosts()).toHaveLength(0);
  });

  it("goes after a while even if its animation never ends", async () => {
    vi.useFakeTimers();
    Element.prototype.getAnimations = () =>
      [
        {
          finished: new Promise(() => undefined),
          effect: { getComputedTiming: () => ({ endTime: 250 }) },
        },
      ] as unknown as Animation[];
    const { rerender } = render(<Frame open />);
    rerender(<Frame open={false} />);
    await act(() => Promise.resolve());
    expect(ghosts()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(EXIT_GHOST_MAX_MS);
    });
    expect(ghosts()).toHaveLength(0);
  });

  it("leaves no copy while the overlay is still on the page", async () => {
    stubAnimations();
    // StrictMode runs the effect, its cleanup and the effect again.
    render(
      <StrictMode>
        <Frame open />
      </StrictMode>,
    );
    await act(() => Promise.resolve());
    expect(ghosts()).toHaveLength(0);
  });

  it("leaves no copy in a browser without Web Animations", async () => {
    const { rerender } = render(<Frame open />);
    rerender(<Frame open={false} />);
    await act(() => Promise.resolve());
    expect(ghosts()).toHaveLength(0);
  });
});
