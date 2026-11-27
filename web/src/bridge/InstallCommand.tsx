// The Mic bridge's one-line install, as Add a Mic bridge (Mics screen) and
// the `/bridge` page show it: `curl -fsSL <address>/bridge/install.sh | sh`,
// where the address is the join address (`joinAddress.ts`), with its warning
// when it is not HTTPS. The server fills that same address into the script.

import type { JoinAddress } from "../joinAddress";
import { t } from "../i18n/t";

/** The command for the server at `address` (no trailing slash). */
export function installCommand(address: string): string {
  return `curl -fsSL ${address}/bridge/install.sh | sh`;
}

export function InstallCommand({
  join,
  size = "large",
}: {
  join: JoinAddress;
  /** `large` on the Stage's Mics screen, `normal` on a computer's page. */
  size?: "large" | "normal";
}) {
  const text = size === "large" ? "text-2xl" : "text-base";
  return (
    <div className="flex flex-col gap-3">
      <code
        aria-label={t("bridge.install.command")}
        data-testid="bridge-install-command"
        className={`block select-all overflow-x-auto rounded-card-sm bg-ink-fill px-5 py-4 font-mono whitespace-nowrap text-white ${text}`}
      >
        {installCommand(join.address)}
      </code>
      {join.warning !== "none" && (
        <p role="alert" className={`font-semibold text-ink-2 ${text}`}>
          {join.warning === "localhost"
            ? t("bridge.install.localhost")
            : t("bridge.install.notHttps")}
        </p>
      )}
    </div>
  );
}
