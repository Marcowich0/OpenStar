// Add a Mic bridge on the Mics screen: a button that opens the install panel
// with the one-line install for the computer the interface is wired to.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { serverInfoQuery } from "../api/queries";
import { InstallCommand } from "../bridge/InstallCommand";
import { t } from "../i18n/t";
import { joinAddress } from "../joinAddress";

/** The panel: nothing shows until the server info (its public URL) is known. */
function InstallPanel() {
  const info = useQuery(serverInfoQuery).data;
  if (info === undefined) return null;
  return (
    <div
      id="mics-add-bridge-panel"
      className="flex flex-col gap-4 rounded-card bg-white px-8 py-6"
    >
      <p className="text-2xl">{t("bridge.install.run")}</p>
      <InstallCommand
        join={joinAddress(info.publicUrl, window.location.origin)}
      />
      <p className="text-2xl text-ink-2">{t("bridge.install.approve")}</p>
    </div>
  );
}

export function AddMicBridge() {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-5" data-testid="mics-add-bridge">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mics-add-bridge-panel"
        onClick={() => {
          setOpen(!open);
        }}
        className="inline-flex min-h-14 cursor-pointer items-center justify-center self-start rounded-full bg-white px-8 text-2xl font-bold shadow-ledge-sm"
      >
        {t("mics.addBridge")}
      </button>
      {open && <InstallPanel />}
    </section>
  );
}
