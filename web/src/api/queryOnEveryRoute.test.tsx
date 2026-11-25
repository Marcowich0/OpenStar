import { useQueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppRouter } from "../router";
import { createQueryClient } from "./queryClient";

describe("TanStack Query on every route", () => {
  it("wraps the whole router in the app's query client", () => {
    const queryClient = createQueryClient();
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ["/admin/profiles"] }),
      queryClient,
    );
    const Wrap = router.options.Wrap;
    if (!Wrap) throw new Error("the router has no Wrap");

    function Probe() {
      const found = useQueryClient();
      return <p>{found === queryClient ? "app client" : "another client"}</p>;
    }
    render(
      <Wrap>
        <Probe />
      </Wrap>,
    );

    expect(screen.getByText("app client")).toBeInTheDocument();
  });

  it("hands the query client to every route's loaders through the context", () => {
    const queryClient = createQueryClient();
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ["/"] }),
      queryClient,
    );

    expect(router.options.context.queryClient).toBe(queryClient);
  });
});
