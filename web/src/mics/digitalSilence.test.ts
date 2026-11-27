import { describe, expect, it } from "vitest";

import { createDigitalSilenceWatch } from "./digitalSilence";

describe("the digital-silence watch", () => {
  it("warns only after more than 2 s of exact zeros", () => {
    const watch = createDigitalSilenceWatch();
    watch.observe("red", true, 1000);
    expect(watch.silent(2999)).toEqual([]);
    expect(watch.silent(3000)).toEqual([]);
    expect(watch.silent(3001)).toEqual(["red"]);
  });

  it("a bridge's zero levels every 100 ms keep one run going", () => {
    const watch = createDigitalSilenceWatch();
    for (let at = 0; at <= 2100; at += 100) watch.observe("b-0", true, at);
    expect(watch.silent(2100)).toEqual(["b-0"]);
  });

  it("any sound ends the run, and the next zeros count from the start", () => {
    const watch = createDigitalSilenceWatch();
    watch.observe("red", true, 0);
    watch.observe("red", false, 1500);
    watch.observe("red", true, 1600);
    expect(watch.silent(3000)).toEqual([]);
    expect(watch.silent(3601)).toEqual(["red"]);
    watch.observe("red", false, 4000);
    expect(watch.silent(9000)).toEqual([]);
  });

  it("quiet noise never warns", () => {
    const watch = createDigitalSilenceWatch();
    for (let at = 0; at <= 10_000; at += 100) watch.observe("blue", false, at);
    expect(watch.silent(10_000)).toEqual([]);
  });

  it("forgets a Local mic that closed or was unplugged", () => {
    const watch = createDigitalSilenceWatch();
    watch.observe("red", true, 0);
    watch.forget("red");
    expect(watch.silent(5000)).toEqual([]);
    watch.observe("red", true, 5000);
    expect(watch.silent(6000)).toEqual([]);
  });

  it("lists every silent Local mic in id order", () => {
    const watch = createDigitalSilenceWatch();
    watch.observe("red", true, 0);
    watch.observe("blue", true, 0);
    watch.observe("green", false, 0);
    expect(watch.silent(2500)).toEqual(["blue", "red"]);
  });
});
