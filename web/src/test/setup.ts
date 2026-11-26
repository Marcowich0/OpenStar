// Vitest setup for every test file: the jest-dom matchers (`toBeInTheDocument`
// and friends), an empty document before each test, and a wait of up to 10 s
// (not Testing Library's 1 s) in `findBy…` and `waitFor`, so a busy machine
// does not fail a test whose condition does come true.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});
