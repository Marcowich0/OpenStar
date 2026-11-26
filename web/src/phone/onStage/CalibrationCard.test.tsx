// Calibrate mics on a Remote's Stage tab (#174): offered from the waiting
// Line-up or the empty Queue with no Admin PIN, never while a Song plays;
// it opens the one run the server holds, and the tab follows that run: the
// checklist, each chosen Mic waiting or ready with Go and Cancel, and the
// result rows.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalibrationRun } from "../../generated/CalibrationRun";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import { StageTab } from "../stage/StageTab";
import {
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "../stage/testParty";

beforeEach(stubFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

const emptyQueue: PartySnapshot = {
  ...PARTY,
  queue: [],
  head: null,
  lineUp: null,
};

const playing: PartySnapshot = {
  ...PARTY,
  lineUp: { ...LINE_UP, canStart: false },
  playing: { requestId: 1, songId: 40, paused: false },
};

const BO = { kind: "phone", phoneId: MY_PHONE } as const;
const JONAS = { kind: "phone", phoneId: "jonas-phone" } as const;

function renderTab(party: PartySnapshot) {
  return renderWithParty(party, (store) => (
    <StageTab store={store} myPhoneId={MY_PHONE} />
  ));
}

const calibrateButton = () =>
  screen.queryByRole("button", { name: "Calibrate mics" });

const card = () => screen.getByTestId("calibration-card");

const checklist = (bo: boolean, jonas: boolean): CalibrationRun => ({
  phase: "choosing",
  mics: [
    { mic: BO, chosen: bo, ready: false },
    { mic: JONAS, chosen: jonas, ready: false },
  ],
});

describe("Calibrate mics on the Stage tab", () => {
  it("is offered on the waiting Line-up and the empty Queue, and opens the run", () => {
    for (const party of [PARTY, emptyQueue]) {
      const { sent, view } = renderTab(party);
      const button = calibrateButton();
      if (!button) throw new Error("no Calibrate mics button");
      fireEvent.click(button);
      expect(sent).toEqual([{ type: "openCalibration" }]);
      view.unmount();
    }
  });

  it("is not offered while a Song plays", () => {
    renderTab(playing);
    expect(calibrateButton()).toBeNull();
  });

  it("shows the run's checklist, and a tick on either device goes to the one run", async () => {
    const { sent, server } = renderTab(PARTY);
    server({ type: "calibration", run: checklist(true, true) });
    expect(calibrateButton()).toBeNull();

    await within(card()).findByText("Jonas");
    const boxes = within(card()).getAllByRole("checkbox");
    expect(boxes.map((box) => box.textContent)).toEqual(["Bo", "Jonas"]);
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
    ]);

    fireEvent.click(within(card()).getByRole("checkbox", { name: "Jonas" }));
    expect(sent).toEqual([
      { type: "chooseCalibrationMic", mic: JONAS, chosen: false },
    ]);

    // The Stage (or any device) unticked Bo: the Remote follows the server.
    server({ type: "calibration", run: checklist(false, true) });
    expect(
      within(card()).getByRole("checkbox", { name: "Bo" }),
    ).toHaveAttribute("aria-checked", "false");

    fireEvent.click(within(card()).getByRole("button", { name: "Continue" }));
    expect(sent.at(-1)).toEqual({ type: "startCalibration" });
  });

  it("needs a ticked Mic to continue, and Cancel ends the run", () => {
    const { sent, server } = renderTab(emptyQueue);
    server({ type: "calibration", run: checklist(false, false) });
    expect(
      within(card()).getByRole("button", { name: "Continue" }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(card()).getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([{ type: "endCalibration" }]);
  });

  it("shows each chosen Mic waiting or ready, Go to start the tones and Cancel before them", async () => {
    const { sent, server } = renderTab(PARTY);
    server({
      type: "calibration",
      run: {
        phase: "waiting",
        mics: [
          { mic: BO, chosen: true, ready: false },
          { mic: JONAS, chosen: true, ready: false },
        ],
      },
    });
    const rows = () => within(card()).getAllByRole("listitem");
    await within(card()).findByText("Bo");
    expect(rows().map((row) => row.textContent)).toEqual([
      "Bowaiting",
      "Jonaswaiting",
    ]);
    // Nothing is ready: Go has nothing to measure.
    expect(within(card()).getByRole("button", { name: "Go" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    server({
      type: "calibration",
      run: {
        phase: "waiting",
        mics: [
          { mic: BO, chosen: true, ready: false },
          { mic: JONAS, chosen: true, ready: true },
        ],
      },
    });
    expect(rows().map((row) => row.textContent)).toEqual([
      "Bowaiting",
      "Jonasready",
    ]);
    fireEvent.click(within(card()).getByRole("button", { name: "Go" }));
    fireEvent.click(within(card()).getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([
      { type: "calibrationGo" },
      { type: "endCalibration" },
    ]);

    // The tones: no Go or Cancel any more.
    server({
      type: "calibration",
      run: {
        phase: "tones",
        mics: [{ mic: JONAS, chosen: true, ready: true }],
      },
    });
    expect(within(card()).getByRole("status")).toHaveTextContent(
      "Listening to the tones. Please stay quiet.",
    );
    expect(within(card()).queryByRole("button")).toBeNull();
  });

  it("shows one result row per Mic when the run ends, and Done closes it", async () => {
    const { sent, server } = renderTab(emptyQueue);
    server({
      type: "calibration",
      run: {
        phase: "results",
        mics: [
          {
            mic: BO,
            chosen: true,
            ready: true,
            outcome: { result: "calibrated", micDelayMs: 101.6 },
          },
          {
            mic: JONAS,
            chosen: true,
            ready: true,
            outcome: { result: "failed" },
          },
        ],
      },
    });
    await within(card()).findByText("Bo · 102 ms ✓");
    expect(
      within(card()).getByText(
        "Jonas couldn't hear the Stage: move closer or turn the sound up",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole("button", { name: "Done" }));
    expect(sent).toEqual([{ type: "endCalibration" }]);

    // The run ended: the button is back.
    server({ type: "calibration", run: null });
    expect(screen.queryByTestId("calibration-card")).toBeNull();
    expect(calibrateButton()).toBeInTheDocument();
  });

  it("hides Check A/V sync while a run is open, and itself while the check runs", () => {
    const { server } = renderTab(PARTY);
    server({ type: "avSync", running: true });
    expect(calibrateButton()).toBeNull();
    server(
      { type: "avSync", running: false },
      { type: "calibration", run: checklist(true, true) },
    );
    expect(screen.queryByRole("button", { name: "Check A/V sync" })).toBeNull();
  });
});
