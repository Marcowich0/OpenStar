// The join card (v1 spec #55, "Song browser and join card"): the QR code for
// `<join address>/?join=<code>`, the Join code as four boxes, the address to
// type and "Pick a song from your phone". When Phones can't reach a working
// join address (plain http, or `localhost`) a warning stands in place of the
// QR code. The song browser's card can hide to a small "Join · 4821" chip;
// the choice lives in this browser's own storage, not in Party state. The
// People overlay shows the card with `hideable={false}`.

import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { t } from "../../i18n/t";
import type { JoinAddress } from "../../joinAddress";
import { Icon } from "../../ui/Icon";
import { QrCode } from "./QrCode";

/** The `localStorage` key of the song browser's Hide choice. */
export const JOIN_CARD_HIDDEN_KEY = "openstar.joinCardHidden";

type HideStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): HideStorage {
  return window.localStorage;
}

/** The link the QR code opens on a Phone. */
export function joinLink(join: JoinAddress, joinCode: string): string {
  return `${join.address}/?join=${joinCode}`;
}

/** The address as a guest types it: without the scheme. */
function typedAddress(join: JoinAddress): string {
  return join.address.replace(/^https?:\/\//, "");
}

export interface JoinCardProps {
  joinCode: string;
  join: JoinAddress;
  /** False on the People overlay, which always shows the code. */
  hideable?: boolean;
  storage?: () => HideStorage;
  /** Placement from the caller. */
  className?: string;
}

export function JoinCard({
  joinCode,
  join,
  hideable = true,
  storage = browserStorage,
  className = "",
}: JoinCardProps) {
  const [hidden, setHidden] = useState(() => hideable && readHidden(storage));
  const hide = (next: boolean) => {
    setHidden(next);
    writeHidden(storage, next);
  };

  if (hidden) {
    return (
      <AriaButton
        aria-label={t("stage.joinCard.chip", { code: joinCode })}
        onPress={() => {
          hide(false);
        }}
        className={`flex items-center gap-3 rounded-full bg-white px-7 py-3 text-[34px] font-semibold text-ink shadow-ledge outline-none ${className}`}
      >
        <span data-testid="party-join-code" className="sr-only">
          {joinCode}
        </span>
        <span aria-hidden="true">
          {t("stage.joinCard.chip", { code: joinCode })}
        </span>
        {join.warning !== "none" && (
          <span
            role="img"
            aria-label={t("stage.joinCard.cantSing")}
            className="flex size-10 items-center justify-center rounded-full bg-red text-white shadow-ledge-red"
          >
            <Icon name="lock" className="size-6" />
          </span>
        )}
      </AriaButton>
    );
  }

  return (
    <aside
      className={`relative flex w-[420px] flex-col items-center gap-4 rounded-card bg-white p-7 text-ink shadow-ledge-lg ${className}`}
    >
      {join.warning === "none" ? (
        <QrCode
          text={joinLink(join, joinCode)}
          label={t("stage.joinCard.qr")}
          className="size-[230px]"
        />
      ) : (
        <JoinWarning warning={join.warning} />
      )}
      <p className="max-w-full truncate text-[26px] font-semibold text-ink-2">
        {t("stage.joinCard.goTo", { address: typedAddress(join) })}
      </p>
      <CodeBoxes joinCode={joinCode} />
      <p className="text-[28px] font-bold">
        {t("stage.browser.pickFromPhone")}
      </p>
      {hideable && (
        <AriaButton
          onPress={() => {
            hide(true);
          }}
          className="absolute -top-5 -right-3 rounded-full bg-ink px-5 py-1.5 text-[22px] font-semibold text-white shadow-ledge-ink outline-none"
        >
          {t("stage.joinCard.hide")}
        </AriaButton>
      )}
    </aside>
  );
}

/** Four white rounded boxes, about 78 × 95 px, digits at 66 % of the height. */
function CodeBoxes({ joinCode }: { joinCode: string }) {
  return (
    <div data-testid="party-join-code" className="flex gap-3">
      {joinCode.split("").map((digit, i) => (
        <b
          // The same digit can appear twice; the position is its identity.
          key={i}
          className="flex h-[95px] w-[78px] items-center justify-center rounded-[22px] bg-white text-[63px] leading-none font-bold tabular-nums shadow-[0_6px_0_var(--color-ledge),inset_0_0_0_3px_var(--color-passed)]"
        >
          {digit}
        </b>
      ))}
    </div>
  );
}

/** In place of the QR code: a white card, dashed red border, lock, why and how. */
function JoinWarning({ warning }: { warning: "notHttps" | "localhost" }) {
  return (
    <div className="flex size-[266px] flex-col items-center justify-center gap-2 rounded-[28px] border-[5px] border-dashed border-red bg-white p-5 text-center leading-tight font-semibold text-warn-fg">
      <Icon name="lock" className="size-14" />
      <p className="text-[24px]">{t("stage.joinCard.cantSing")}</p>
      <p className="text-[17px] font-medium text-ink-2">
        {warning === "localhost"
          ? t("stage.joinCard.localhost")
          : t("stage.joinCard.notHttps")}
      </p>
    </div>
  );
}

function readHidden(storage: () => HideStorage): boolean {
  try {
    return storage().getItem(JOIN_CARD_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeHidden(storage: () => HideStorage, hidden: boolean) {
  try {
    storage().setItem(JOIN_CARD_HIDDEN_KEY, String(hidden));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}
