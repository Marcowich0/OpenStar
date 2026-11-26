// The Admin PIN step in front of the Stage (v1 spec #45): a browser that is
// not a remembered Stage browser sees the Admin PIN pad before anything else;
// a remembered one sees the Stage at once. The live client waits for the same
// Stage trust before it opens `/ws/stage`, so a correct PIN connects it.

import { useState, useSyncExternalStore, type ReactNode } from "react";

import type { StageTrust } from "../../live/stageTrust";
import { t } from "../../i18n/t";
import { AdminPinDialog } from "../../pin/AdminPinDialog";
import { Button } from "../../ui/Button";

export function StageTrustGate({
  trust,
  children,
}: {
  trust: StageTrust;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(trust.subscribe, trust.getSnapshot);
  const [padOpen, setPadOpen] = useState(true);

  if (state === "trusted") return children;
  return (
    <main
      className="flex h-screen flex-col items-center justify-center gap-10 bg-cream px-16 text-center font-sans text-ink"
      data-stage-trust={state}
    >
      {state === "pinNeeded" && (
        <>
          <h1 className="text-5xl font-bold">{t("stageTrust.heading")}</h1>
          <Button
            fill="ink"
            onPress={() => {
              setPadOpen(true);
            }}
          >
            {t("stageTrust.enterPin")}
          </Button>
          <AdminPinDialog
            isOpen={padOpen}
            onOpenChange={setPadOpen}
            onSuccess={() => undefined}
            check={trust.giveAdminPin}
          />
        </>
      )}
    </main>
  );
}
