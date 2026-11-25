import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";

// Pins the component-test setup: jsdom, Testing Library and the jest-dom
// matchers. Real component tests sit next to the component they test.
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      onClick={() => {
        setCount((value) => value + 1);
      }}
    >
      Clicked {count}
    </button>
  );
}

test("a component renders and reacts to clicks under jsdom", () => {
  render(<Counter />);
  const button = screen.getByRole("button");
  expect(button).toHaveTextContent("Clicked 0");
  fireEvent.click(button);
  expect(screen.getByRole("button")).toHaveTextContent("Clicked 1");
});

test("each test starts from an empty document", () => {
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
