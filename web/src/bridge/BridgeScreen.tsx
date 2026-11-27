// `/bridge`: the Mic bridge install page, for a computer that isn't the
// Stage. The same one-line install as Add a Mic bridge, and a direct download
// of the server's own bridge build with its checksum. No PIN: approving a new
// bridge on the Stage is the guard.

import { useQuery } from "@tanstack/react-query";

import { serverInfoQuery } from "../api/queries";
import { t } from "../i18n/t";
import { joinAddress } from "../joinAddress";
import { InstallCommand } from "./InstallCommand";

export function BridgeScreen() {
  const info = useQuery(serverInfoQuery).data;
  const join =
    info === undefined
      ? null
      : joinAddress(info.publicUrl, window.location.origin);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 text-ink">
      <h1 className="text-4xl font-bold">{t("bridge.title")}</h1>
      <p className="text-lg">{t("bridge.intro")}</p>
      {join !== null && (
        <>
          <section className="flex flex-col gap-3">
            <p className="text-lg">{t("bridge.install.run")}</p>
            <InstallCommand join={join} size="normal" />
            <p className="text-lg text-ink-2">{t("bridge.install.approve")}</p>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-2xl font-bold">{t("bridge.download.title")}</h2>
            <ul className="flex flex-col gap-2 text-lg">
              <li>
                <a
                  href="/bridge/openstar-mic-bridge"
                  download
                  className="font-semibold underline"
                >
                  {t("bridge.download.binary")}
                </a>
              </li>
              <li>
                <a
                  href="/bridge/openstar-mic-bridge.sha256"
                  className="underline"
                >
                  {t("bridge.download.checksum")}
                </a>
              </li>
            </ul>
            <p className="text-lg">
              {t("bridge.download.run", { address: join.address })}
            </p>
          </section>
        </>
      )}
      <p className="font-mono text-base text-ink-2">{t("bridge.uninstall")}</p>
    </main>
  );
}
