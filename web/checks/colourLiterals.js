// Colour literals belong only in the token definitions. Everything else names
// a colour by palette key or token (`tokens.ts`), so a theme is a swap of CSS
// variables. `eslint.config.js` applies `colourLiteralRule` to TypeScript; the
// test beside this file runs `cssColourLiterals` over the stylesheets.

/** Files that define the tokens, relative to `web/`; the only ones allowed colour literals. */
export const COLOUR_LITERAL_ALLOWED = [
  "src/theme/tokens.css",
  "src/theme/tokens.test.ts",
  "src/theme/readToken.test.ts",
];

// A hex colour (3, 4, 6 or 8 digits, not followed by more of a word), or the
// start of an rgb(), rgba(), hsl() or hsla() function.
const HEX = String.raw`#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])`;
const FUNCTION = String.raw`\b(?:rgb|hsl)a?\(`;

const message =
  "No colour literals outside src/theme/tokens.css: name a colour by palette key or token (tokenVar, readToken).";

/** ESLint `no-restricted-syntax` options that flag colour literals in strings. @type {[2, ...{ selector: string, message: string }[]]} */
export const colourLiteralRule = [
  2,
  {
    selector: `Literal[value=/${HEX}|${FUNCTION}/i]`,
    message,
  },
  {
    selector: `TemplateElement[value.raw=/${HEX}|${FUNCTION}/i]`,
    message,
  },
];

/**
 * The colour literals in a stylesheet, ignoring comments.
 * @param {string} css
 * @returns {string[]}
 */
export function cssColourLiterals(css) {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(new RegExp(`${HEX}|${FUNCTION}`, "gi"))].map(
    (match) => match[0],
  );
}
