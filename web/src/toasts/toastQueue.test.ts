import { describe, expect, it } from "vitest";

import type { ChangeEvent } from "../generated/ChangeEvent";
import { initialLiveState, type LiveState } from "../live/liveState";
import { addToast, dismissToast } from "../live/toasts";
import {
  TOAST_LEAVE_MS,
  TOAST_POP_IN_MS,
  TOAST_STAY_MS,
  toastPhase,
} from "./toastQueue";

const moved = (title: string, memberId = 1): ChangeEvent => ({
  actor: { kind: "member", memberId },
  event: {
    code: "requestMovedUp",
    params: { requestId: 1, songId: 1, title },
  },
});

function arrive(state: LiveState, change: ChangeEvent): LiveState {
  return { ...state, ...addToast(state, true, change) };
}

const titles = (state: LiveState) =>
  state.toasts.map((toast) =>
    toast.event.code === "requestMovedUp" ? toast.event.params.title : "",
  );

describe("the Stage's toast queue", () => {
  it("shows at most three; a fourth pushes out the oldest", () => {
    let state = initialLiveState;
    for (const title of ["Africa", "Shallow", "Toxic", "Hello"]) {
      state = arrive(state, moved(title));
    }
    expect(titles(state)).toEqual(["Shallow", "Toxic", "Hello"]);
  });

  it("keeps the order they arrived in, oldest at the top", () => {
    let state = arrive(initialLiveState, moved("Africa"));
    state = arrive(state, moved("Shallow"));
    state = dismissToast(state, state.toasts[0]?.id ?? -1);
    state = arrive(state, moved("Toxic"));
    expect(titles(state)).toEqual(["Shallow", "Toxic"]);
  });

  it("pops in for about 0.45 s, stays about 4 s and fades up for about 0.35 s", () => {
    expect(TOAST_POP_IN_MS).toBe(450);
    expect(TOAST_STAY_MS).toBe(4000);
    expect(TOAST_LEAVE_MS).toBe(350);
    expect(toastPhase(0)).toBe("showing");
    expect(toastPhase(3999)).toBe("showing");
    expect(toastPhase(4000)).toBe("leaving");
    expect(toastPhase(4349)).toBe("leaving");
    expect(toastPhase(4350)).toBe("gone");
  });
});
