import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithServerInfo } from "../bridge/bridgeTestKit";
import { AddMicBridge } from "./AddMicBridge";

const command = () => screen.getByTestId("bridge-install-command");

describe("Add a Mic bridge", () => {
  it("shows the guide's steps without a press", () => {
    renderWithServerInfo(<AddMicBridge />, "https://openstar.example.org");
    const guide = screen.getByRole("region", { name: "Add a Mic bridge" });
    const steps = within(guide).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/open a terminal and run this/);
    expect(steps[1]).toHaveTextContent(/approve it .* with the code it shows/);
  });

  it("links the download, with how to start it by hand", () => {
    renderWithServerInfo(<AddMicBridge />, "https://openstar.example.org");
    const link = screen.getByRole("link", { name: /Download the Mic bridge/ });
    expect(link).toHaveAttribute("href", "/bridge/openstar-mic-bridge");
    expect(link).toHaveAttribute("download");
    expect(screen.getByTestId("mics-add-bridge")).toHaveTextContent(
      "write https://openstar.example.org into ~/.config/openstar-mic-bridge/server",
    );
  });

  it("shows the one-line install for OPENSTAR_PUBLIC_URL, with no warning over HTTPS", () => {
    renderWithServerInfo(<AddMicBridge />, "https://openstar.example.org");
    expect(command()).toHaveTextContent(
      "curl -fsSL https://openstar.example.org/bridge/install.sh | sh",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when the address is not HTTPS and still offers the command", () => {
    renderWithServerInfo(<AddMicBridge />, "http://10.0.0.5:8080");
    expect(command()).toHaveTextContent(
      "curl -fsSL http://10.0.0.5:8080/bridge/install.sh | sh",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/not HTTPS/);
  });

  it("uses the Stage's own address without a public URL, and says localhost works only on this computer", () => {
    renderWithServerInfo(<AddMicBridge />, null);
    expect(command()).toHaveTextContent(
      `curl -fsSL ${window.location.origin}/bridge/install.sh | sh`,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /only on the Stage's own computer/,
    );
  });
});
