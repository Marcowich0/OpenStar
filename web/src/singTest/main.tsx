// The entry of `sing-test.html`, the test-only painter screenshot page (#203):
// `?case=<one|four|eight|duet>&t=<seconds>`. Built with `vite build --mode
// screenshots` by `just e2e` and `just update-screenshots`; the production
// build (`index.html`) never includes it. Wait for
// `[data-sing-screen][data-painted]` before a screenshot.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../theme/fonts";
import "../index.css";

import { SingTestScreen } from "./SingTestScreen";
import { parseSingTestSearch } from "./search";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <SingTestScreen search={parseSingTestSearch(window.location.search)} />
  </StrictMode>,
);
