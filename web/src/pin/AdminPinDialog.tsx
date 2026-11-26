// The Admin PIN pad (v1 spec #45): the Admin PIN form of the number pad,
// wired to the server. OK sends the attempt to `check` (by default
// `POST /api/unlock`, the Unlock); the server alone decides.
//
// - A wrong PIN (`403 wrongPin`) clears the entry and says so.
// - During the shared wrong-guess wait (`429 adminPinWait { secondsLeft }`)
//   the pad shows "Too many wrong PINs, try again in 0:42", counting down,
//   and takes no key until it reaches zero.
// - A correct PIN closes the pad and calls the caller's `onSuccess`, so the
//   same pad serves the Unlock (#185) and becoming the Stage (#186), which
//   passes its own `check`.
//
// It lives outside `admin/` and `stage/` because both use it. Only one number
// pad may be on screen at a time: it listens for keys on the whole page.

import { useEffect, useState } from "react";
import {
  Dialog as AriaDialog,
  Modal,
  ModalOverlay,
} from "react-aria-components";

import { ApiFailure, api } from "../api/api";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import { Button } from "../ui/Button";
import { NumberPad, type PadAnswer } from "../ui/NumberPad";
import { formatWait } from "./formatWait";

/**
 * One PIN attempt. Resolves when the PIN was right; rejects with an
 * `ApiFailure` otherwise (`wrongPin`, `adminPinWait`, or any other failure).
 */
export type PinCheck = (pin: string) => Promise<unknown>;

/** The Unlock: `POST /api/unlock`. */
export const unlockWithPin: PinCheck = (pin) =>
  api("POST /api/unlock", { body: { pin } });

export interface AdminPinDialogProps {
  isOpen: boolean;
  /** Cancel (Esc, the veil, the Cancel key) and success both close it. */
  onOpenChange: (isOpen: boolean) => void;
  /** Called once the server took the PIN, after the pad has closed. */
  onSuccess: () => void;
  /** The attempt to make; the Unlock unless the caller passes another. */
  check?: PinCheck;
}

export function AdminPinDialog({
  isOpen,
  onOpenChange,
  onSuccess,
  check = unlockWithPin,
}: AdminPinDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-veil p-4 transition-opacity duration-300 ease-spring data-entering:opacity-0 data-exiting:opacity-0"
    >
      <Modal className="w-full max-w-md rounded-card bg-cream text-ink shadow-ledge-lg transition-transform duration-350 ease-spring data-entering:scale-90 data-exiting:scale-90">
        <AriaDialog
          aria-label={t("numberPad.adminPin")}
          className="flex flex-col items-center gap-4 p-6 font-sans outline-none"
        >
          <AdminPinPad
            check={check}
            onSuccess={() => {
              onOpenChange(false);
              onSuccess();
            }}
          />
          <Button
            fill="white"
            onPress={() => {
              onOpenChange(false);
            }}
            className="w-full max-w-sm"
          >
            {t("adminPinPad.cancel")}
          </Button>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

type PadMessage =
  | { kind: "none" }
  | { kind: "wrong"; text: string }
  | { kind: "failed" }
  | { kind: "wait"; until: number };

function AdminPinPad({
  check,
  onSuccess,
}: {
  check: PinCheck;
  onSuccess: () => void;
}) {
  const [message, setMessage] = useState<PadMessage>({ kind: "none" });
  const [now, setNow] = useState(() => Date.now());

  const waitUntil = message.kind === "wait" ? message.until : null;
  useEffect(() => {
    if (waitUntil === null) return;
    const tick = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= waitUntil) setMessage({ kind: "none" });
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, [waitUntil]);

  async function submit(pin: string): Promise<PadAnswer | undefined> {
    try {
      await check(pin);
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      const failure = error.failure;
      if (failure.kind === "refused" && failure.error.code === "adminPinWait") {
        const at = Date.now();
        setNow(at);
        setMessage({
          kind: "wait",
          until: at + failure.error.params.secondsLeft * 1000,
        });
        return "refused";
      }
      if (failure.kind === "refused" && failure.error.code === "wrongPin") {
        setMessage({ kind: "wrong", text: userMessageText(failure.error) });
        return "refused";
      }
      setMessage({ kind: "failed" });
      return undefined;
    }
    onSuccess();
    return "accepted";
  }

  let text: string | undefined;
  switch (message.kind) {
    case "none":
      text = undefined;
      break;
    case "wrong":
      text = message.text;
      break;
    case "failed":
      text = t("adminPinPad.failed");
      break;
    case "wait":
      text = t("adminPinPad.wait", {
        time: formatWait(Math.ceil((message.until - now) / 1000)),
      });
      break;
  }

  return (
    <NumberPad
      form="adminPin"
      onSubmit={submit}
      message={text}
      locked={message.kind === "wait"}
    />
  );
}
