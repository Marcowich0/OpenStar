// Compile-time checks of the server-text mapping. Never run; `tsc` checks
// each `@ts-expect-error`.

import type { PartyEvent } from "../generated/PartyEvent";
import type { UserMessage } from "../generated/UserMessage";
import { byCode, type CodeHandlers } from "./serverText";
import { t } from "./t";

const handlers: CodeHandlers<UserMessage> = {
  invalidMessage: () => t("userMessage.invalidMessage"),
  notTheStage: () => t("userMessage.notTheStage"),
  serverError: () => t("userMessage.serverError"),
  profileNameEmpty: () => t("userMessage.profileNameEmpty"),
  profileNameTooLong: ({ params }) =>
    t("userMessage.profileNameTooLong", params),
  profileNameTaken: () => t("userMessage.profileNameTaken"),
  profileNotFound: () => t("userMessage.profileNotFound"),
  joinCodeWrong: () => t("userMessage.joinCodeWrong"),
  partyFull: () => t("userMessage.partyFull"),
  notInParty: () => t("userMessage.notInParty"),
  jobCancelled: () => t("userMessage.jobCancelled"),
  jobInterrupted: () => t("userMessage.jobInterrupted"),
  toolNotFound: ({ params }) => t("userMessage.toolNotFound", params),
  toolFailed: ({ params }) =>
    t("userMessage.toolFailed", {
      tool: params.tool,
      exitCode: params.exitCode ?? 0,
    }),
};

// A code the Rust side adds (here `queueFull`) fails until it is mapped.
type WithNewCode = UserMessage | { code: "queueFull"; params: { max: number } };
// @ts-expect-error: `queueFull` has no handler.
export const unmapped = byCode<WithNewCode>(handlers);

export const mapped = byCode<WithNewCode>({
  ...handlers,
  queueFull: ({ params }) => String(params.max),
});

declare const missingOne: Omit<typeof handlers, "serverError">;
// @ts-expect-error: every code of the union needs a handler.
export const missing = byCode<UserMessage>(missingOne);

export const wrongParam = byCode<PartyEvent>({
  // @ts-expect-error: `partyStarted` has `joinCode`, not `max`.
  partyStarted: ({ params }) => String(params.max),
  memberJoined: ({ params }) => params.name,
  phoneJoined: ({ params }) => params.name,
});
