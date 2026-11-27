import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SongMedia } from "../../generated/SongMedia";
import { SingBackdrop } from "./SingBackdrop";

const media: SongMedia = {
  audio: { url: "/api/songs/7/media/audio", native: true },
  video: {
    kind: "file",
    file: { url: "/api/songs/7/media/video", native: true },
    gapSeconds: 0,
  },
  cover: "/api/songs/7/media/cover",
  background: "/api/songs/7/media/background",
  tileColour: "grape",
};

function images(container: HTMLElement) {
  return [...container.querySelectorAll("img")].map((img) =>
    img.getAttribute("src"),
  );
}

describe("SingBackdrop", () => {
  it("plays the music video full screen with object-fit: cover, over the backdrop image", () => {
    const { container } = render(<SingBackdrop media={media} />);
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/api/songs/7/media/video");
    expect(video).toHaveClass("object-cover", "size-full");
    expect(images(container)).toEqual(["/api/songs/7/media/background"]);
  });

  it("plays a video that is in the audio file from the audio URL", () => {
    const { container } = render(
      <SingBackdrop media={{ ...media, video: { kind: "inAudio" } }} />,
    );
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "/api/songs/7/media/audio",
    );
  });

  it("mutes a separate video file, which follows the audio (ticket 212), but not one in the audio file", () => {
    const separate = render(<SingBackdrop media={media} />).container;
    expect(separate.querySelector("video")?.muted).toBe(true);
    const inAudio = render(
      <SingBackdrop media={{ ...media, video: { kind: "inAudio" } }} />,
    ).container;
    expect(inAudio.querySelector("video")?.muted).toBe(false);
  });

  it("shows no video while it converts, nor without one", () => {
    const converting: SongMedia = {
      ...media,
      video: {
        kind: "file",
        file: { url: "/api/songs/7/media/video", native: false },
        gapSeconds: 0,
      },
    };
    expect(
      render(<SingBackdrop media={converting} />).container.querySelector(
        "video",
      ),
    ).toBeNull();
    expect(
      render(
        <SingBackdrop
          media={{
            ...media,
            video: { kind: "inAudio" },
            audio: { ...media.audio, native: false },
          }}
        />,
      ).container.querySelector("video"),
    ).toBeNull();
    expect(
      render(
        <SingBackdrop media={{ ...media, video: null }} />,
      ).container.querySelector("video"),
    ).toBeNull();
  });

  it("hides the video while the caller says so, keeping the backdrop", () => {
    const { container } = render(
      <SingBackdrop media={media} showVideo={false} />,
    );
    expect(container.querySelector("video")).toHaveClass("invisible");
    expect(images(container)).toEqual(["/api/songs/7/media/background"]);
  });

  it("falls back from the background to the cover to the generated tile", () => {
    const { container } = render(
      <SingBackdrop media={{ ...media, video: null }} />,
    );
    const img = () => container.querySelector("img");
    expect(img()).toHaveClass("object-cover", "size-full");
    fireEvent.error(img() as HTMLImageElement);
    expect(images(container)).toEqual(["/api/songs/7/media/cover"]);
    fireEvent.error(img() as HTMLImageElement);
    expect(images(container)).toEqual([]);
    const tile = container.querySelector<HTMLElement>("[data-backdrop-tile]");
    expect(tile?.style.backgroundColor).toBe("var(--color-party-grape)");
  });

  it("starts from the cover, or the tile, when the Song has no background", () => {
    expect(
      images(
        render(
          <SingBackdrop media={{ ...media, video: null, background: null }} />,
        ).container,
      ),
    ).toEqual(["/api/songs/7/media/cover"]);
    const { container } = render(
      <SingBackdrop
        media={{ ...media, video: null, background: null, cover: null }}
      />,
    );
    expect(images(container)).toEqual([]);
    expect(container.querySelector("[data-backdrop-tile]")).not.toBeNull();
  });

  it("shows no image under the blobs (ticket 263), but keeps a video that carries the sound", () => {
    const { container } = render(
      <SingBackdrop
        media={{ ...media, video: { kind: "inAudio" }, background: null }}
        background="blobs"
        showVideo={false}
      />,
    );
    expect(images(container)).toEqual([]);
    expect(container.querySelector("[data-backdrop-tile]")).toBeNull();
    expect(container.querySelector("video")).toHaveClass("invisible");
  });
});
