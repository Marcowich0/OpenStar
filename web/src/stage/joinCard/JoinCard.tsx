// The join card (v1 spec #55, "Song browser and join card"): the QR code for
// `<join address>/?join=<code>`, the Join code as four boxes, the address to
// type and "Pick a song from your phone". When Phones can't reach a working
// join address (plain http, or `localhost`) a warning stands in place of the
// QR code. The song browser's card can hide to a small "Join · 4821" chip;
// the choice lives in this browser's own storage, not in Party state. The
// song browser holds that choice itself (`useJoinCardHidden`), because it
// keeps a lane clear for the card only while the card shows. The People
// overlay shows the card with `hideable={false}`.

import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { t } from "../../i18n/t";
import type { JoinAddress } from "../../joinAddress";
import { Icon } from "../../ui/Icon";
import { QrCode } from "./QrCode";

/** The `localStorage` key of the song browser's Hide choice. */
export const JOIN_CARD_HIDDEN_KEY = "openstar.joinCardHidden";

/** The width of the `tall` card, which the song browser keeps a lane for. */
export const TALL_CARD_WIDTH_PX = 420;

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
  /**
   * `tall` (the song browser's corner): QR code over the code. `wide` (the
   * People overlay's bottom row): QR code beside it, so the card is short.
   */
  layout?: "tall" | "wide";
  /**
   * The Hide choice, when the caller holds it (`useJoinCardHidden`); the card
   * holds its own otherwise.
   */
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
  /** Placement from the caller, on a wrapper (card and chip alike). */
  className?: string;
}

/**
 * The song browser's Hide choice, read from and written to this browser's
 * storage. False, and never stored, when the card may not hide.
 */
export function useJoinCardHidden(
  storage: () => HideStorage = browserStorage,
  hideable = true,
): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(() => hideable && readHidden(storage));
  const hide = (next: boolean) => {
    setHidden(next);
    writeHidden(storage, next);
  };
  return [hideable && hidden, hide];
}

export function JoinCard({
  joinCode,
  join,
  hideable = true,
  storage = browserStorage,
  layout = "tall",
  hidden: heldHidden,
  onHiddenChange,
  className = "",
}: JoinCardProps) {
  const [ownHidden, setOwnHidden] = useJoinCardHidden(storage, hideable);
  const held = heldHidden !== undefined && onHiddenChange !== undefined;
  const hidden = hideable && (held ? heldHidden : ownHidden);
  const hide = held ? onHiddenChange : setOwnHidden;

  if (hidden) {
    return (
      <div className={className}>
        <AriaButton
          aria-label={t("stage.joinCard.chip", { code: joinCode })}
          onPress={() => {
            hide(false);
          }}
          className="flex items-center gap-3 rounded-full bg-surface px-7 py-3 text-[34px] font-semibold text-ink shadow-ledge outline-none"
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
      </div>
    );
  }

  return (
    <div className={className}>
      <aside
        data-layout={layout}
        style={layout === "tall" ? { width: TALL_CARD_WIDTH_PX } : undefined}
        className={`relative flex items-center gap-4 rounded-card bg-surface p-7 text-ink shadow-ledge-lg ${layout === "wide" ? "max-w-[760px] flex-row gap-7" : "flex-col"}`}
      >
        {join.warning === "none" ? (
          <QrCode
            text={joinLink(join, joinCode)}
            label={t("stage.joinCard.qr")}
            className={`${layout === "wide" ? "size-[200px]" : "size-[230px]"} shrink-0`}
          />
        ) : (
          <JoinWarning warning={join.warning} short={layout === "wide"} />
        )}
        <div className="flex min-w-0 flex-col items-center gap-4">
          <p className="max-w-full truncate text-[26px] font-semibold text-ink-2">
            {t("stage.joinCard.goTo", { address: typedAddress(join) })}
          </p>
          <CodeBoxes joinCode={joinCode} />
          <p className="text-[28px] font-bold">
            {t("stage.browser.pickFromPhone")}
          </p>
        </div>
        {hideable && (
          <AriaButton
            onPress={() => {
              hide(true);
            }}
            className="absolute -top-5 -right-3 rounded-full bg-ink-fill px-5 py-1.5 text-[22px] font-semibold text-white shadow-ledge-ink outline-none"
          >
            {t("stage.joinCard.hide")}
          </AriaButton>
        )}
      </aside>
    </div>
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
          className="flex h-[95px] w-[78px] items-center justify-center rounded-[22px] bg-surface text-[63px] leading-none font-bold tabular-nums shadow-[0_6px_0_var(--color-ledge),inset_0_0_0_3px_var(--color-passed)]"
        >
          {digit}
        </b>
      ))}
    </div>
  );
}

/** In place of the QR code: a white card, dashed red border, lock, why and how. */
function JoinWarning({
  warning,
  short,
}: {
  warning: "notHttps" | "localhost";
  /** Beside the code (the wide card) it need not match the QR code's height. */
  short: boolean;
}) {
  return (
    <div
      className={`flex ${short ? "min-h-[200px]" : "min-h-[266px]"} w-[310px] flex-col items-center justify-center gap-2 rounded-[28px] border-[5px] border-dashed border-red bg-surface p-5 text-center leading-tight font-semibold text-warn-fg`}
    >
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
