/**
 * The join address: where Phones join the Party (the join QR code) and where
 * a Mic bridge installs from (Add a Mic bridge). It is `OPENSTAR_PUBLIC_URL`
 * when the server reports one, otherwise the address the Stage was opened on.
 */

/** Which warning goes with a join address. `localhost` wins over `notHttps`. */
export type JoinWarning = "none" | "notHttps" | "localhost";

export interface JoinAddress {
  /** The address, without a trailing slash. */
  address: string;
  warning: JoinWarning;
}

/**
 * @param publicUrl `ServerInfo.publicUrl`
 * @param stageOrigin the address the Stage was opened on (`window.location.origin`)
 */
export function joinAddress(
  publicUrl: string | null,
  stageOrigin: string,
): JoinAddress {
  const address = (publicUrl ?? stageOrigin).replace(/\/+$/, "");
  return { address, warning: warningFor(address) };
}

function warningFor(address: string): JoinWarning {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "notHttps";
  }
  if (isLocalhost(url.hostname)) return "localhost";
  return url.protocol === "https:" ? "none" : "notHttps";
}

/** Phones and other computers can't reach these names. */
function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}
