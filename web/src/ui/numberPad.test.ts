import { describe, expect, it } from "vitest";

import { EMPTY_PAD, padStep, type PadAction, type PadForm } from "./numberPad";

/** Runs actions from an empty pad; returns the last state and every submit. */
function run(form: PadForm, actions: PadAction[]) {
  let state = EMPTY_PAD;
  const submitted: string[] = [];
  for (const action of actions) {
    const step = padStep(form, state, action);
    state = step.state;
    if (step.submit !== null) submitted.push(step.submit);
  }
  return { state, submitted };
}

const digits = (text: string): PadAction[] =>
  Array.from(text, (digit): PadAction => ({ type: "digit", digit }));

describe("the Join code pad", () => {
  it("takes digits one by one", () => {
    const { state, submitted } = run("joinCode", digits("48"));
    expect(state.digits).toBe("48");
    expect(submitted).toEqual([]);
  });

  it("submits as soon as the fourth digit is typed", () => {
    const { state, submitted } = run("joinCode", digits("4821"));
    expect(submitted).toEqual(["4821"]);
    expect(state).toMatchObject({ digits: "4821", pending: true });
  });

  it("ignores more digits and OK", () => {
    const { state, submitted } = run("joinCode", [
      ...digits("48217"),
      { type: "ok" },
    ]);
    expect(submitted).toEqual(["4821"]);
    expect(state.digits).toBe("4821");
  });

  it("has no OK: OK never submits a short code", () => {
    expect(
      run("joinCode", [...digits("48"), { type: "ok" }]).submitted,
    ).toEqual([]);
  });

  it("deletes the last digit", () => {
    expect(
      run("joinCode", [...digits("482"), { type: "delete" }]).state.digits,
    ).toBe("48");
    expect(run("joinCode", [{ type: "delete" }]).state.digits).toBe("");
  });

  it("clears the entry and marks it refused when the code is refused", () => {
    const { state } = run("joinCode", [...digits("4821"), { type: "refused" }]);
    expect(state).toEqual({ digits: "", pending: false, refused: true });
  });

  it("is a new try after a refusal: the next digit clears the refusal", () => {
    const { state, submitted } = run("joinCode", [
      ...digits("4821"),
      { type: "refused" },
      ...digits("1234"),
    ]);
    expect(submitted).toEqual(["4821", "1234"]);
    expect(state.refused).toBe(false);
  });
});

describe("the Admin PIN pad", () => {
  it("does not submit at four digits", () => {
    const { state, submitted } = run("adminPin", digits("1234"));
    expect(submitted).toEqual([]);
    expect(state.pending).toBe(false);
  });

  it("submits only on OK", () => {
    expect(
      run("adminPin", [...digits("123456"), { type: "ok" }]).submitted,
    ).toEqual(["123456"]);
  });

  it("needs at least 4 digits", () => {
    expect(
      run("adminPin", [...digits("123"), { type: "ok" }]).submitted,
    ).toEqual([]);
  });

  it("takes at most 8 digits", () => {
    const { submitted } = run("adminPin", [
      ...digits("1234567890"),
      { type: "ok" },
    ]);
    expect(submitted).toEqual(["12345678"]);
  });

  it("takes nothing while the caller checks the PIN", () => {
    const { state, submitted } = run("adminPin", [
      ...digits("1234"),
      { type: "ok" },
      ...digits("5"),
      { type: "delete" },
      { type: "ok" },
    ]);
    expect(submitted).toEqual(["1234"]);
    expect(state.digits).toBe("1234");
  });

  it("is free again once the caller accepts", () => {
    const { state } = run("adminPin", [
      ...digits("1234"),
      { type: "ok" },
      { type: "accepted" },
    ]);
    expect(state).toEqual({ digits: "1234", pending: false, refused: false });
  });

  it("ignores anything that is not a digit", () => {
    expect(run("adminPin", digits("1a2")).state.digits).toBe("12");
  });
});
