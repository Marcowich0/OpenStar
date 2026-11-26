import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import { createQueryClient } from "../api/queryClient";
import { serverInfoQuery } from "../api/queries";

/** Renders `ui` with the server info already known: `publicUrl` as given. */
export function renderWithServerInfo(ui: ReactNode, publicUrl: string | null) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(serverInfoQuery.queryKey, {
    version: "dev",
    schemaVersion: 1,
    libraryReadOnly: null,
    publicUrl,
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}
