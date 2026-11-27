import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithServerInfo } from "../bridge/bridgeTestKit";
import { AddMicBridge } from "./AddMicBridge";

const command = () => screen.getByTestId("bridge-install-command");

/** Opens the For the owner fold, which holds the guide. */
function openFold() {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "For the owner" }));
  });
}

describe("Add a Mic bridge", () => {
  it("says in one line what a Mic bridge is for, with the setup guide in a closed For the owner fold", () => {
    renderWithServerInfo(<AddMicBridge />, "https://openstar.example.org");
    const guide = screen.getByRole("region", { name: "Add a Mic bridge" });
    expect(
      within(guide).getByText(
        "A Mic bridge brings every input of an audio interface to the Stage. Ask the owner to set one up.",
      ),
    ).toBeVisible();
    const fold = within(guide).getByRole("button", { name: "For the owner" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(command()).not.toBeVisible();
    expect(within(guide).queryByRole("listitem")).toBeNull();

    // The Stage's Enter goes to the focused button.
    act(() => {
      fold.focus();
      fireEvent.keyDown(fold, { key: "Enter" });
      fireEvent.keyUp(fold, { key: "Enter" });
    });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(command()).toBeVisible();
    const steps = within(guide).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/open a terminal and run this/);
    expect(steps[1]).toHaveTextContent(/approve it .* with the code it shows/);
  });

  it("links the download, with how to start it by hand", () => {
    renderWithServerInfo(<AddMicBridge />, "https://openstar.example.org");
    openFold();
    const link = screen.getByRole("link", { name: /Download the Mic bridge/ });
    expect(link).toHaveAttribute("href", "/bridge/openstar-mic-bridge");
    expect(link).toHaveAttribute("download");
    expect(screen.getByTestId("mics-add-bridge")).toHaveTextContent(
      "write https://openstar.example.org into ~/.config/openstar-mic-bridge/server",
    );
  });

  it("shows the one-line install for OPENSTAR_PUBLIC_URL, with no warning over HTTPS", () => {
    renderWithServerInfo(<AddMicBridge />, "https://openstar.example.org");
    openFold();
    expect(command()).toHaveTextContent(
      "curl -fsSL https://openstar.example.org/bridge/install.sh | sh",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when the address is not HTTPS and still offers the command", () => {
    renderWithServerInfo(<AddMicBridge />, "http://10.0.0.5:8080");
    openFold();
    expect(command()).toHaveTextContent(
      "curl -fsSL http://10.0.0.5:8080/bridge/install.sh | sh",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/not HTTPS/);
  });

  it("uses the Stage's own address without a public URL, and says localhost works only on this computer", () => {
    renderWithServerInfo(<AddMicBridge />, null);
    openFold();
    expect(command()).toHaveTextContent(
      `curl -fsSL ${window.location.origin}/bridge/install.sh | sh`,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /only on the Stage's own computer/,
    );
  });
});
