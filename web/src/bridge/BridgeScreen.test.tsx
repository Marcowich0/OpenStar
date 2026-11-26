import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BridgeScreen } from "./BridgeScreen";
import { renderWithServerInfo } from "./bridgeTestKit";

describe("/bridge", () => {
  it("shows the install command and a direct download, with no PIN", () => {
    renderWithServerInfo(<BridgeScreen />, "https://openstar.example.org");
    expect(
      screen.getByRole("heading", { level: 1, name: "Mic bridge" }),
    ).toBeVisible();
    expect(screen.getByTestId("bridge-install-command")).toHaveTextContent(
      "curl -fsSL https://openstar.example.org/bridge/install.sh | sh",
    );
    const download = screen.getByRole("link", { name: /Download/ });
    expect(download).toHaveAttribute("href", "/bridge/openstar-mic-bridge");
    expect(screen.getByRole("link", { name: /SHA-256/ })).toHaveAttribute(
      "href",
      "/bridge/openstar-mic-bridge.sha256",
    );
    expect(screen.getByText(/--uninstall/)).toBeVisible();
    expect(screen.queryByText(/PIN/)).toBeNull();
  });

  it("warns as the Mics screen does when the address is not HTTPS", () => {
    renderWithServerInfo(<BridgeScreen />, "http://10.0.0.5:8080");
    expect(screen.getByRole("alert")).toHaveTextContent(/not HTTPS/);
  });
});
