// Compile-time checks of `t()` and the catalogue. This file is never run:
// `tsc` checks it, and each `@ts-expect-error` fails the build if its line
// stops being an error.

import { en } from "./en";
import { createTranslator, t, type Catalogue } from "./t";

export function translationTypeChecks() {
  t("join.enterCode");
  t("join.code", { code: "0427" });
  t("server.version", { version: "1.2.0", schemaVersion: 3 });

  // @ts-expect-error: there is no such key in the English catalogue.
  t("join.enterTheCode");

  // @ts-expect-error: `join.code` needs its `code` parameter.
  t("join.code");

  // @ts-expect-error: `join.code` needs `code`, not `joinCode`.
  t("join.code", { joinCode: "0427" });

  // @ts-expect-error: `schemaVersion` is a `{schemaVersion, number}` parameter.
  t("server.version", { version: "1.2.0", schemaVersion: "3" });

  // @ts-expect-error: `code` is a string parameter.
  t("join.code", { code: 427 });

  // @ts-expect-error: an entry without parameters takes none.
  t("join.enterCode", { code: "0427" });

  // A plural entry needs `count`, and `count` is a number.
  const plural = createTranslator(
    { songs: { one: "{count, number} Song", other: "{count, number} Songs" } },
    "en",
  );
  plural("songs", { count: 2 });
  // @ts-expect-error: a plural entry needs `count`.
  plural("songs");
  // @ts-expect-error: `count` is a number.
  plural("songs", { count: "2" });
}

// A second language is typed by the English catalogue.
export const complete: Catalogue = en;

declare const missingAKey: Omit<typeof en, "join.code">;
// @ts-expect-error: a catalogue missing `join.code` is not a `Catalogue`.
export const incomplete: Catalogue = missingAKey;

// @ts-expect-error: a plural entry where English has a plain text is wrong.
export const wrongShape: Catalogue = { ...en, "join.enterCode": { other: "" } };
