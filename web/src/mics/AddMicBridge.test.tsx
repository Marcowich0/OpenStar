import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithServerInfo } from "../bridge/bridgeTestKit";
import { AddMicBridge } from "./AddMicBridge";

function openPanel(publicUrl: string | null) {
  renderWithServerInfo(<AddMicBridge />, publicUrl);
  const button = screen.getByRole("button", { name: "Add a Mic bridge" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
}

const command = () => screen.getByTestId("bridge-install-command");

describe("Add a Mic bridge", () => {
  it("shows the one-line install for OPENSTAR_PUBLIC_URL, with no warning over HTTPS", () => {
    openPanel("https://openstar.example.org");
    expect(command()).toHaveTextContent(
      "curl -fsSL https://openstar.example.org/bridge/install.sh | sh",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when the address is not HTTPS and still offers the command", () => {
    openPanel("http://10.0.0.5:8080");
    expect(command()).toHaveTextContent(
      "curl -fsSL http://10.0.0.5:8080/bridge/install.sh | sh",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/not HTTPS/);
  });

  it("uses the Stage's own address without a public URL, and says localhost works only on this computer", () => {
    openPanel(null);
    expect(command()).toHaveTextContent(
      `curl -fsSL ${window.location.origin}/bridge/install.sh | sh`,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /only on the Stage's own computer/,
    );
  });

  it("closes again", () => {
    openPanel("https://openstar.example.org");
    fireEvent.click(screen.getByRole("button", { name: "Add a Mic bridge" }));
    expect(screen.queryByTestId("bridge-install-command")).toBeNull();
  });
});
