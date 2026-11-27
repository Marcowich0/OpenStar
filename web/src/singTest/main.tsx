// The entry of `sing-test.html`, the test-only painter screenshot page (#203):
// `?case=<one|four|eight|duet>&t=<seconds>&lyricSize=…&theme=…` (see
// `search.ts`). Built with `vite build --mode screenshots` by `just e2e` and
// `just update-screenshots`; the production build (`index.html`) never
// includes it. Wait for
// `[data-sing-screen][data-painted]` before a screenshot.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../theme/fonts";
import "../index.css";

import { applyTheme } from "../theme/themes";
import { SingTestScreen } from "./SingTestScreen";
import { parseSingTestSearch } from "./search";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const search = parseSingTestSearch(window.location.search);
// The theme before the first frame, as the Stage's would be.
applyTheme(search.theme);

createRoot(root).render(
  <StrictMode>
    <SingTestScreen search={search} />
  </StrictMode>,
);
