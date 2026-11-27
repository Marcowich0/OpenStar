import { describe, expect, it } from "vitest";

import { createImageCache } from "./coverImages";

/** A stand-in `<img>`: loads when the test says so. */
function fakeImages() {
  const made: { src: string; complete: boolean; naturalWidth: number }[] = [];
  return {
    made,
    create: () => {
      const image = { src: "", complete: false, naturalWidth: 0 };
      made.push(image);
      return image as unknown as HTMLImageElement;
    },
  };
}

describe("the cover image cache", () => {
  it("starts loading an image the first time its URL is asked for, and gives it once it has loaded", () => {
    const fake = fakeImages();
    const cache = createImageCache(fake.create);
    expect(cache.get("/covers/1.jpg")).toBeNull();
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]?.src).toBe("/covers/1.jpg");

    const image = fake.made[0];
    if (!image) throw new Error("no image");
    image.complete = true;
    image.naturalWidth = 300;
    expect(cache.get("/covers/1.jpg")).toBe(image);
    expect(fake.made).toHaveLength(1);
  });

  it("gives nothing for an image that failed (complete with no size), and does not retry it", () => {
    const fake = fakeImages();
    const cache = createImageCache(fake.create);
    cache.get("/covers/broken.jpg");
    const image = fake.made[0];
    if (!image) throw new Error("no image");
    image.complete = true;
    expect(cache.get("/covers/broken.jpg")).toBeNull();
    expect(fake.made).toHaveLength(1);
  });
});
