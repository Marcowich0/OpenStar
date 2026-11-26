// Forget on a bridge group of the Mics screen (v1 spec #51, "Uninstall and
// Forget"): a press and hold that removes the bridge's approval and its Local
// mics with their Mic delays, bleed levels and Mic thresholds. It deletes kept
// data, so it goes through the guarded-action flow: without an Unlock the
// Admin PIN pad opens, and the server decides.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, ApiFailure, type Refusal } from "../api/api";
import { localMicsQuery, micBridgesQuery } from "../api/queries";
import type { ApiError } from "../generated/ApiError";
import type { ApiErrorCode } from "../generated/ApiErrorCode";
import type { MicBridge } from "../generated/MicBridge";
import { useGuardedAction } from "../guarded/useGuardedAction";
import { apiErrorText, userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import { HoldButton } from "../ui/HoldButton";

// The guard's and the PIN's codes; any other refusal is a `UserMessage`.
const API_ERROR_CODES = {
  wrongPin: true,
  unlockRequired: true,
  libraryReadOnly: true,
  stagePinRequired: true,
} as const satisfies Record<ApiErrorCode, true>;

function isApiError(refusal: Refusal): refusal is ApiError {
  return Object.hasOwn(API_ERROR_CODES, refusal.code);
}

function problemText(error: unknown): string {
  if (!(error instanceof ApiFailure) || error.failure.kind !== "refused")
    return t("mics.bridge.forgetFailed");
  const refusal = error.failure.error;
  return isApiError(refusal) ? apiErrorText(refusal) : userMessageText(refusal);
}

export function ForgetBridge({ bridge }: { bridge: MicBridge }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const forget = useGuardedAction(() =>
    api("DELETE /api/mic-bridges/{id}", { params: { id: bridge.bridgeId } }),
  );

  function onHold() {
    setProblem(null);
    forget.run().then(
      (outcome) => {
        // The change notices refresh these too; this need not wait for them.
        if (outcome.kind === "done") {
          void queryClient.invalidateQueries(micBridgesQuery);
          void queryClient.invalidateQueries(localMicsQuery);
        }
      },
      (error: unknown) => {
        setProblem(problemText(error));
      },
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <HoldButton
        fill="red"
        size="small"
        aria-label={t("mics.bridge.forget", { host: bridge.hostName })}
        onHold={onHold}
        className="w-44 shrink-0"
      >
        {t("mics.bridge.forgetShort")}
      </HoldButton>
      {problem === null ? null : (
        <p role="alert" className="text-2xl font-semibold text-red">
          {problem}
        </p>
      )}
      {forget.dialog}
    </div>
  );
}
