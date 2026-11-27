import { describe, expect, it } from "vitest";

import { createFirstSongMemory, pauseHintInput } from "./pauseHint";

/** A Storage stand-in that keeps its items in a Map. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

describe("the first Song of a Party", () => {
  it("is the first Request to start in the Party, and only that one", () => {
    const memory = createFirstSongMemory(memoryStorage());
    expect(memory.isFirstSong("party-1", 7)).toBe(true);
    // The same Song again (a re-render, a Restart): still the first.
    expect(memory.isFirstSong("party-1", 7)).toBe(true);
    expect(memory.isFirstSong("party-1", 8)).toBe(false);
    expect(memory.isFirstSong("party-1", 7)).toBe(true);
  });

  it("starts over when a new Party starts", () => {
    const memory = createFirstSongMemory(memoryStorage());
    memory.isFirstSong("party-1", 7);
    expect(memory.isFirstSong("party-2", 8)).toBe(true);
    expect(memory.isFirstSong("party-2", 9)).toBe(false);
  });

  it("survives a Stage reload through its storage", () => {
    const storage = memoryStorage();
    createFirstSongMemory(storage).isFirstSong("party-1", 7);
    const reloaded = createFirstSongMemory(storage);
    expect(reloaded.isFirstSong("party-1", 8)).toBe(false);
    expect(reloaded.isFirstSong("party-1", 7)).toBe(true);
  });

  it("still works in memory when storage throws or holds junk", () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const memory = createFirstSongMemory(throwing);
    expect(memory.isFirstSong("party-1", 7)).toBe(true);
    expect(memory.isFirstSong("party-1", 8)).toBe(false);

    const junk = memoryStorage();
    junk.setItem("openstar.firstSong", "{not json");
    expect(createFirstSongMemory(junk).isFirstSong("party-1", 8)).toBe(true);
    expect(createFirstSongMemory(null).isFirstSong("party-1", 8)).toBe(true);
  });
});

describe("pauseHintInput", () => {
  it("names the keyboard until the gamepad ticket (issue 275) tracks the last input device", () => {
    expect(pauseHintInput()).toBe("keyboard");
  });
});
