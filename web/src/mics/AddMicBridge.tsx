// Add a Mic bridge on the Mics screen: one line for whoever is at the TV, and
// a short guide, folded "For the owner" (spec #241), to set up a bridge on the
// computer the interface is wired to. Run the one-line install there (or
// download the binary and start it by hand, as on the `/bridge` page), then
// approve the bridge here under New bridges.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { serverInfoQuery } from "../api/queries";
import { InstallCommand } from "../bridge/InstallCommand";
import { t } from "../i18n/t";
import { joinAddress } from "../joinAddress";
import { OwnerFold } from "../ui/OwnerFold";

/** One numbered step of the guide. */
function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-5">
      <span
        aria-hidden="true"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-2xl font-bold text-cream"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1 text-2xl">
        {children}
      </div>
    </li>
  );
}

export function AddMicBridge() {
  // Nothing about the address shows until the server info (its public URL) is known.
  const info = useQuery(serverInfoQuery).data;
  const join =
    info === undefined
      ? null
      : joinAddress(info.publicUrl, window.location.origin);
  return (
    <section
      aria-labelledby="mics-add-bridge"
      className="flex flex-col gap-5"
      data-testid="mics-add-bridge"
    >
      <h3 id="mics-add-bridge" className="text-3xl font-bold">
        {t("mics.addBridge")}
      </h3>
      <div className="flex flex-col gap-6 rounded-card bg-white px-8 py-6">
        <p className="text-2xl">{t("mics.addBridge.line")}</p>
        <OwnerFold className="text-2xl">
          <div className="flex flex-col gap-6 pt-2">
            <p className="text-2xl text-ink-2">{t("bridge.intro")}</p>
            <ol className="flex flex-col gap-6">
              <Step number={1}>
                <p>{t("bridge.install.run")}</p>
                {join !== null && (
                  <>
                    <InstallCommand join={join} />
                    <div className="flex flex-col gap-2 text-ink-2">
                      <p className="font-semibold text-ink">
                        {t("bridge.download.title")}
                      </p>
                      <p>
                        <a
                          href="/bridge/openstar-mic-bridge"
                          download
                          className="font-semibold text-ink underline"
                        >
                          {t("bridge.download.binary")}
                        </a>
                      </p>
                      <p>
                        {t("bridge.download.run", { address: join.address })}
                      </p>
                    </div>
                  </>
                )}
              </Step>
              <Step number={2}>
                <p>{t("bridge.install.approve")}</p>
              </Step>
            </ol>
          </div>
        </OwnerFold>
      </div>
    </section>
  );
}
