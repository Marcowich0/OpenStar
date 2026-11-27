// Finds references to an external host in built HTML, CSS or JS: an absolute
// URL (`https://host/…`) or a protocol-relative one in a CSS `url()` or
// `@import`, or an HTML `src`/`href` (`//host/…`).

/**
 * Hosts that appear in the build as plain strings and are never fetched.
 * Add one only with its reason.
 */
const NEVER_FETCHED = new Set([
  // XML namespace names in SVG markup (React DOM, inline SVG).
  "www.w3.org",
  // React's production error messages link to their explanation.
  "react.dev",
  // TanStack Router's base for parsing relative URLs; never a remote host.
  "localhost",
]);

// A host name starts with a letter or digit, so "http://." in a sentence is no host.
const ABSOLUTE = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]*)/gi;
const PROTOCOL_RELATIVE =
  /(?:url\(\s*["']?|@import\s+["']|(?:src|href)\s*=\s*["']?)\/\/([a-z0-9][a-z0-9.-]*)/gi;

/**
 * Every external host `code` references, in order, except the never-fetched ones.
 * @param {string} code
 * @returns {string[]}
 */
export function externalHosts(code) {
  return [...code.matchAll(ABSOLUTE), ...code.matchAll(PROTOCOL_RELATIVE)]
    .map((match) => (match[1] ?? "").toLowerCase())
    .filter((host) => !NEVER_FETCHED.has(host));
}
