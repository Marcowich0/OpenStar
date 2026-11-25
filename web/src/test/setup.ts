// Vitest setup for every test file: the jest-dom matchers (`toBeInTheDocument`
// and friends) and an empty document before each test.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
