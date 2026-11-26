// A button that starts a guarded action through `useGuardedAction`: the
// shape most guarded actions take. A press-and-hold action (Forget a Mic
// bridge, deleting a Song) calls the hook itself and runs it on hold.

import type { ReactNode } from "react";

import { Button, type ButtonFill } from "../ui/Button";
import { useGuardedAction } from "./useGuardedAction";

export interface GuardedButtonProps<T> {
  /** Sends the guarded request; the server checks the Unlock. */
  action: () => Promise<T>;
  /** Called with the answer once the action is done. */
  onDone?: (value: T) => void;
  /**
   * Called with any failure other than the Unlock the pad takes care of;
   * without it the failure is reported as an uncaught error.
   */
  onFailure?: (error: unknown) => void;
  writesLibrary?: boolean;
  children: ReactNode;
  fill?: ButtonFill;
  className?: string;
  /** Disabled for a reason of the caller's (besides an Unlock in progress). */
  isDisabled?: boolean;
}

export function GuardedButton<T>({
  action,
  onDone,
  onFailure = reportError,
  writesLibrary = false,
  children,
  fill = "white",
  className = "",
  isDisabled = false,
}: GuardedButtonProps<T>) {
  const guarded = useGuardedAction(action, { writesLibrary });
  return (
    <>
      <Button
        fill={fill}
        className={className}
        isDisabled={guarded.isDisabled || isDisabled}
        onPress={() => {
          guarded.run().then((outcome) => {
            if (outcome.kind === "done") onDone?.(outcome.value);
          }, onFailure);
        }}
      >
        {children}
      </Button>
      {guarded.dialog}
    </>
  );
}
