// The images the sing screen's painter draws (#264: the title card's cover).
// The painter holds no logic and imports only types, so it reads images
// through a getter: this cache loads each URL once and gives the image only
// once it has loaded. Until then, or when it fails, the painter draws the
// fallback instead.

/** Gives the loaded image for `url`, or `null` while it loads or after it failed. */
export type ImageSource = (url: string) => HTMLImageElement | null;

export interface ImageCache {
  get: ImageSource;
}

/** A cache of images by URL, each made by `create` and loaded once. */
export function createImageCache(
  create: () => HTMLImageElement = () => new Image(),
): ImageCache {
  const images = new Map<string, HTMLImageElement>();
  return {
    get(url) {
      let image = images.get(url);
      if (!image) {
        image = create();
        image.decoding = "async";
        image.src = url;
        images.set(url, image);
      }
      // A failed image is complete with no size; it is never retried.
      return image.complete && image.naturalWidth > 0 ? image : null;
    },
  };
}
