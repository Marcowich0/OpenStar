import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./theme/fonts";
import "./index.css";

import { createAppRouter } from "./router";
import { BubblePopBackground } from "./ui/BubblePopBackground";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    {/* Every screen sits on the Bubble Pop background; the sing screen's
        video covers it. */}
    <BubblePopBackground>
      <RouterProvider router={createAppRouter()} />
    </BubblePopBackground>
  </StrictMode>,
);
