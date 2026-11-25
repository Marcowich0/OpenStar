import { useSearch } from "@tanstack/react-router";

import { t } from "../i18n/t";
import { JoinScreen } from "./JoinScreen";
import { ServerStatus } from "./ServerStatus";

/** `/`: the Phone screens (join, mic takeover, Remote). A placeholder for now. */
export function PhoneScreen() {
  const { join } = useSearch({ from: "/" });
  return (
    <main>
      <h1>{t("phone.title")}</h1>
      <JoinScreen joinCode={join} />
      <ServerStatus />
    </main>
  );
}
