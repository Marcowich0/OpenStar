import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./Button";
import { UiCueContext, type UiCue } from "./uiCue";

describe("Button", () => {
  it("is a button named by its content that reports a press", () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Sing!</Button>);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Sing!" }));
    });
    expect(onPress).toHaveBeenCalledOnce();
  });

  it.each([
    ["white", "bg-surface", "shadow-ledge"],
    ["green", "bg-green", "shadow-ledge-green"],
    ["red", "bg-red", "shadow-ledge-red"],
    ["ink", "bg-ink-fill", "shadow-ledge-ink"],
  ] as const)(
    "in %s has its fill and its own darker ledge",
    (fill, fillClass, ledgeClass) => {
      render(<Button fill={fill}>Go</Button>);
      const classes = screen.getByRole("button").classList;
      expect(classes).toContain(fillClass);
      expect(classes).toContain(ledgeClass);
      expect(classes).toContain("rounded-full");
    },
  );

  it("breathes when asked to, only while the browser allows motion", () => {
    render(<Button breathing>Start</Button>);
    const classes = screen.getByRole("button").classList;
    // Reduced motion stops the breathing: it is decoration, not a cue.
    expect(classes).toContain("motion-safe:animate-breathe");
    expect(classes).not.toContain("animate-breathe");
  });

  describe("disabled", () => {
    it("stays focusable, is announced as disabled and does not report a press", () => {
      const onPress = vi.fn();
      render(
        <Button isDisabled onPress={onPress}>
          Start
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Start" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      act(() => {
        button.focus();
      });
      expect(button).toHaveFocus();
      act(() => {
        fireEvent.click(button);
      });
      expect(onPress).not.toHaveBeenCalled();
    });

    it("shakes when pressed, until the shake ends", () => {
      render(<Button isDisabled>Start</Button>);
      const button = screen.getByRole("button");
      expect(button).not.toHaveAttribute("data-shaking");
      act(() => {
        fireEvent.click(button);
      });
      expect(button).toHaveAttribute("data-shaking", "true");
      expect(button.classList).toContain("data-shaking:animate-shake");
      act(() => {
        fireEvent.animationEnd(button);
      });
      expect(button).not.toHaveAttribute("data-shaking");
    });

    it("does not breathe", () => {
      render(
        <Button isDisabled breathing>
          Start
        </Button>,
      );
      expect(screen.getByRole("button").className).not.toContain(
        "animate-breathe",
      );
    });
  });
  describe("its sounds (Stage only, ticket 261)", () => {
    function withCues(ui: React.ReactNode) {
      const cues: UiCue[] = [];
      render(<UiCueContext value={(cue) => cues.push(cue)}>{ui}</UiCueContext>);
      return cues;
    }

    it("asks for select when pressed, by click or by Enter", () => {
      const cues = withCues(<Button onPress={() => {}}>Sing!</Button>);
      const button = screen.getByRole("button");
      fireEvent.click(button);
      act(() => {
        button.focus();
      });
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
      expect(cues).toEqual(["select", "select"]);
    });

    it("asks for refuse when a greyed one is pressed and shakes", () => {
      const onPress = vi.fn();
      const cues = withCues(
        <Button isDisabled onPress={onPress}>
          Start
        </Button>,
      );
      fireEvent.click(screen.getByRole("button"));
      expect(cues).toEqual(["refuse"]);
      expect(onPress).not.toHaveBeenCalled();
    });

    it("is marked as sounding itself, so the Stage's click rule skips it", () => {
      withCues(<Button>Go</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("data-ui-cue");
    });

    it("plays nothing without a cue player, as on a Phone", () => {
      const onPress = vi.fn();
      render(<Button onPress={onPress}>Go</Button>);
      fireEvent.click(screen.getByRole("button"));
      expect(onPress).toHaveBeenCalledOnce();
    });
  });
});
