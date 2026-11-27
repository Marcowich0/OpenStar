import { afterEach, describe, expect, it } from "vitest";

import { answerAsStageTab, stageTabOpen } from "./stageTab";

describe("stageTabOpen", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it("is true while another tab is the Stage", async () => {
    stops.push(answerAsStageTab(() => true));
    await expect(stageTabOpen()).resolves.toBe(true);
  });

  it("is false when no tab answers", async () => {
    await expect(stageTabOpen(50)).resolves.toBe(false);
  });

  it("is false when the Stage tab is no longer the Stage", async () => {
    stops.push(answerAsStageTab(() => false));
    await expect(stageTabOpen(50)).resolves.toBe(false);
  });

  it("is false once the Stage tab stops answering", async () => {
    answerAsStageTab(() => true)();
    await expect(stageTabOpen(50)).resolves.toBe(false);
  });
});
