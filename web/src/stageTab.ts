// Is this browser already the Stage in another tab? The Admin area's Stage
// link (spec #241) asks before it opens `/stage`: in a remembered Stage
// browser, `/stage` takes the Stage at once, so a second tab on the Stage
// computer would take it from the TV tab mid-Song. Tabs of one browser
// share a BroadcastChannel; the Stage tab answers while it is the Stage.

const CHANNEL = "openstar-stage-tab";

type StageTabMessage = { type: "ask" } | { type: "here" };

/** How long a question waits for the Stage tab's answer. */
export const STAGE_TAB_WAIT_MS = 300;

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(CHANNEL);
}

/**
 * Answers every question while `isStage()` holds. Returns the function that
 * stops answering.
 */
export function answerAsStageTab(isStage: () => boolean): () => void {
  const open = channel();
  if (!open) return () => undefined;
  open.onmessage = (event: MessageEvent<StageTabMessage>) => {
    if (event.data.type === "ask" && isStage())
      open.postMessage({ type: "here" } satisfies StageTabMessage);
  };
  return () => {
    open.close();
  };
}

/** Resolves to whether another tab of this browser is the Stage. */
export function stageTabOpen(waitMs = STAGE_TAB_WAIT_MS): Promise<boolean> {
  const open = channel();
  if (!open) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (answer: boolean) => {
      clearTimeout(timer);
      open.close();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      done(false);
    }, waitMs);
    open.onmessage = (event: MessageEvent<StageTabMessage>) => {
      if (event.data.type === "here") done(true);
    };
    open.postMessage({ type: "ask" } satisfies StageTabMessage);
  });
}
