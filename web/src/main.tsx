import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./theme/fonts";
import "./index.css";

import { invalidateOnChange } from "./api/changeNotices";
import { createQueryClient } from "./api/queryClient";
import { liveStore } from "./live/browserLive";
import { createAppRouter } from "./router";
import { followStageTheme } from "./theme/stageTheme";
import { BubblePopBackground } from "./ui/BubblePopBackground";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// One query client per browser, kept current by the change notices on the
// browser's one WebSocket.
const queryClient = createQueryClient();
invalidateOnChange(liveStore(), queryClient);
// Every screen shows the Stage's theme, and follows it when it changes.
followStageTheme(queryClient);

createRoot(root).render(
  <StrictMode>
    {/* Every screen sits on the Bubble Pop background; the sing screen's
        video covers it. */}
    <BubblePopBackground>
      <RouterProvider router={createAppRouter(undefined, queryClient)} />
    </BubblePopBackground>
  </StrictMode>,
);
