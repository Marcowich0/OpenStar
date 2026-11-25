import { describe, expect, it } from "vitest";

import {
  forgetRememberedProfile,
  phoneId,
  rememberedProfileId,
  rememberProfile,
  type PhoneStorage,
} from "./phoneId";

function memoryStorage(): PhoneStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

let counter = 0;
const newId = () => `id-${String(++counter)}`;

describe("the Phone id", () => {
  it("is made once and then kept in storage", () => {
    const storage = memoryStorage();
    const first = phoneId(storage, newId);
    expect(first).toMatch(/^id-\d+$/);
    expect(phoneId(storage, newId)).toBe(first);
    expect(phoneId(storage, newId)).toBe(first);
  });

  it("is a new Phone once storage is cleared", () => {
    const storage = memoryStorage();
    const first = phoneId(storage, newId);
    storage.items.clear();
    expect(phoneId(storage, newId)).not.toBe(first);
  });

  it("defaults to a random UUID", () => {
    expect(phoneId(memoryStorage())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("still works, for this page only, when storage is unavailable", () => {
    const broken: PhoneStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(phoneId(broken, newId)).toMatch(/^id-\d+$/);
  });
});

describe("the remembered Profile", () => {
  it("is kept apart from the Phone id", () => {
    const storage = memoryStorage();
    const id = phoneId(storage, newId);
    expect(rememberedProfileId(storage)).toBeNull();
    rememberProfile(storage, 7);
    expect(rememberedProfileId(storage)).toBe(7);
    expect(phoneId(storage, newId)).toBe(id);
    forgetRememberedProfile(storage);
    expect(rememberedProfileId(storage)).toBeNull();
    expect(phoneId(storage, newId)).toBe(id);
  });

  it("ignores a stored value that is not a Profile id", () => {
    const storage = memoryStorage();
    storage.setItem("openstar.profileId", "seven");
    expect(rememberedProfileId(storage)).toBeNull();
  });
});
