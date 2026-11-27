// The "For the owner" fold (spec #241): where the Stage shows a setup problem
// (the join card without HTTPS, Add a Mic bridge, Downloads without USDB), it
// says one friendly line and folds the owner's detail (variable names,
// `curl | sh`, file paths) away under this, closed until pressed. The trigger
// is a button, so the Stage's focus ring reaches it and Enter opens it. The
// Admin area shows the same detail in full, with no fold.
//
// Its text size comes from where it sits; the chevron follows it.

import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Disclosure,
  DisclosurePanel,
} from "react-aria-components";

import { t } from "../i18n/t";
import { Icon } from "./Icon";

export interface OwnerFoldProps {
  /** The owner's detail, hidden until the fold opens. */
  children: ReactNode;
  /** Where the trigger and the detail line up: `center` in the join card. */
  align?: "start" | "center";
  /** Placement and size from the caller, on the fold's wrapper. */
  className?: string;
}

export function OwnerFold({
  children,
  align = "start",
  className = "",
}: OwnerFoldProps) {
  return (
    <Disclosure
      className={`flex flex-col gap-2 ${align === "center" ? "items-center" : "items-start"} ${className}`}
    >
      {({ isExpanded }) => (
        <>
          <AriaButton
            slot="trigger"
            className="inline-flex items-center gap-2 rounded-full bg-white px-[0.8em] py-[0.3em] font-semibold text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
          >
            <Icon
              name="chevron"
              className={`size-[1em] transition-transform ${isExpanded ? "rotate-90" : ""}`}
            />
            {t("ownerFold.title")}
          </AriaButton>
          <DisclosurePanel className="flex flex-col gap-2">
            {children}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}
