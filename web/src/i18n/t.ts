// The one way text reaches the screen: `t(key, params)` against the English
// catalogue (`en.ts`). There is no i18n library; this file is all of it.
//
// Catalogue syntax, which a translator copies:
// - `{name}` puts in the string parameter `name`;
// - `{name, number}` puts in the number parameter `name`, formatted for the
//   catalogue's language (`1,000` in English, `1.000` in German);
// - a plural entry is an object of `Intl.PluralRules` forms (`one`, `other`,
//   and `zero`, `two`, `few`, `many` where the language has them). It takes
//   a number parameter `count`, which picks the form. `other` is required.
//
// The parameters of every key are worked out from its English text, so an
// unknown key, a missing parameter and a parameter of the wrong type are all
// `tsc` errors (see `t.typetest.ts`).

import { en } from "./en";

/** The plural forms of one entry; `Intl.PluralRules` picks among them. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & {
  other: string;
};

/** One catalogue entry: a text, or the plural forms of a text. */
export type Entry = string | PluralForms;

/** The `{…}` placeholders in a text, as written (`name` or `name, number`). */
type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}`
    ? P | Placeholders<Rest>
    : never;

type ParamName<P extends string> = P extends `${infer N}, number` ? N : P;
type ParamType<P extends string> = P extends `${string}, number`
  ? number
  : string;

/** The parameters a text takes, worked out from its placeholders. */
type TextParams<S extends string> = {
  [P in Placeholders<S> as ParamName<P>]: ParamType<P>;
};

/** The parameters an entry takes; a plural entry always takes `count`. */
export type ParamsOf<E> = E extends string
  ? TextParams<E>
  : E extends PluralForms
    ? TextParams<Extract<E[keyof E], string>> & { count: number }
    : never;

/** `t`'s arguments after the key: none, or the entry's parameters. */
export type ArgsOf<E> = keyof ParamsOf<E> extends never
  ? []
  : [params: ParamsOf<E>];

/** A translate function over the keys of catalogue `C`. */
export type Translate<C extends Record<string, Entry>> = <
  K extends keyof C & string,
>(
  key: K,
  ...args: ArgsOf<C[K]>
) => string;

/** The English catalogue's keys. */
export type MessageKey = keyof typeof en;

/**
 * The shape every language's catalogue has: every key of the English one, a
 * text where English has a text and plural forms where English has plural
 * forms. A catalogue missing a key fails `tsc`.
 */
export type Catalogue = {
  readonly [K in MessageKey]: (typeof en)[K] extends string
    ? string
    : PluralForms;
};

const PLACEHOLDER = /\{(\w+)(, number)?\}/g;

/**
 * One run of a translated text: plain text, or the value of the parameter
 * `param` as put in (so a screen can set names or Song titles in bold).
 */
export interface TextPart {
  text: string;
  param?: string;
}

/** Like {@link Translate}, but gives the text as runs. */
export type TranslateParts<C extends Record<string, Entry>> = <
  K extends keyof C & string,
>(
  key: K,
  ...args: ArgsOf<C[K]>
) => TextPart[];

/** Looks an entry up and splits it into runs, parameters filled in. */
function partsTranslator(
  catalogue: Readonly<Record<string, Entry>>,
  locale: string,
): (key: string, params?: Readonly<Record<string, unknown>>) => TextPart[] {
  const plurals = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);

  const split = (
    text: string,
    params: Readonly<Record<string, unknown>>,
  ): TextPart[] => {
    const parts: TextPart[] = [];
    let at = 0;
    for (const match of text.matchAll(PLACEHOLDER)) {
      const [whole, name = "", isNumber] = match;
      if (match.index > at) parts.push({ text: text.slice(at, match.index) });
      at = match.index + whole.length;
      const value = params[name];
      if (isNumber !== undefined && typeof value === "number") {
        parts.push({ text: numbers.format(value), param: name });
      } else if (typeof value === "string") {
        parts.push({ text: value, param: name });
      } else {
        parts.push({ text: whole });
      }
    }
    if (at < text.length) parts.push({ text: text.slice(at) });
    return parts;
  };

  return (key, params = {}) => {
    // Types rule out an unknown key; plain JavaScript could still pass one.
    const entry: Entry | undefined = catalogue[key];
    if (entry === undefined) return [{ text: key }];
    if (typeof entry === "string") return split(entry, params);
    const count = typeof params.count === "number" ? params.count : 0;
    return split(entry[plurals.select(count)] ?? entry.other, params);
  };
}

/** Builds `t` for one catalogue and the language its texts are in. */
export function createTranslator<const C extends Record<string, Entry>>(
  catalogue: C,
  locale: string,
): Translate<C> {
  const parts = partsTranslator(catalogue, locale);
  return (key, ...args) =>
    parts(key, args[0])
      .map((part) => part.text)
      .join("");
}

/** Builds `tParts` for one catalogue and the language its texts are in. */
export function createPartsTranslator<const C extends Record<string, Entry>>(
  catalogue: C,
  locale: string,
): TranslateParts<C> {
  const parts = partsTranslator(catalogue, locale);
  return (key, ...args) => parts(key, args[0]);
}

/** Turns a catalogue key and its parameters into English text. */
export const t: Translate<typeof en> = createTranslator(en, "en");

/** Like `t`, as runs of plain text and parameter values. */
export const tParts: TranslateParts<typeof en> = createPartsTranslator(
  en,
  "en",
);
