import { describe, expect, it } from "vitest";
import { joinAddress } from "./joinAddress";

describe("joinAddress", () => {
  it("uses OPENSTAR_PUBLIC_URL when it is set, with no warning for HTTPS", () => {
    expect(joinAddress("https://openstar.example.org", "http://192.168.1.5:8080")).toEqual({
      address: "https://openstar.example.org",
      warning: "none",
    });
  });

  it("uses the address the Stage was opened on when no public URL is set", () => {
    expect(joinAddress(null, "https://karaoke.home.example")).toEqual({
      address: "https://karaoke.home.example",
      warning: "none",
    });
  });

  it("warns that Phones can't sing when the join address is not HTTPS", () => {
    expect(joinAddress(null, "http://192.168.1.5:8080")).toEqual({
      address: "http://192.168.1.5:8080",
      warning: "notHttps",
    });
    expect(joinAddress("http://openstar.lan", "https://x.example")).toEqual({
      address: "http://openstar.lan",
      warning: "notHttps",
    });
  });

  it("gives the localhost warning instead of not-HTTPS on localhost", () => {
    expect(joinAddress(null, "http://localhost:8080")).toEqual({
      address: "http://localhost:8080",
      warning: "localhost",
    });
  });

  it("gives the localhost warning even over HTTPS", () => {
    expect(joinAddress(null, "https://localhost").warning).toBe("localhost");
  });

  it("treats loopback addresses and *.localhost as localhost", () => {
    for (const origin of [
      "http://127.0.0.1:8080",
      "http://127.1.2.3",
      "http://[::1]:8080",
      "http://openstar.localhost",
      "http://LOCALHOST:8080",
    ]) {
      expect(joinAddress(null, origin).warning, origin).toBe("localhost");
    }
  });

  it("drops a trailing slash from the address", () => {
    expect(joinAddress("https://openstar.example.org/", "http://x").address).toBe(
      "https://openstar.example.org",
    );
  });

  it("warns not-HTTPS for an address it cannot read", () => {
    expect(joinAddress("not a url", "http://x").warning).toBe("notHttps");
  });
});
