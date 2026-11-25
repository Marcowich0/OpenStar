// The rules for Local mics the Stage browser reads itself (v1 spec #51,
// "Capture in the Stage browser"): which input devices count, how a device
// splits into Local mics, their ids, default names and Mics-screen order,
// and which devices are open. The capture itself is `localMicCapture.ts`.
//
// A Local mic here is one channel of one input device: (Stage browser,
// `deviceId`, channel). Chromium opens at most 2 channels per device, so a
// stereo device gives Left and Right, a mono device one Local mic. The
// browser never sees or changes an interface's PipeWire profile.

import type { LocalMic } from "../generated/LocalMic";
import type { LocalMicSource } from "../generated/LocalMicSource";
import type { MicBridge } from "../generated/MicBridge";
import { t } from "../i18n/t";

/** An input device the Stage browser can open. */
export interface BrowserDevice {
  deviceId: string;
  label: string;
}

/** The browser variant of a Local mic's source. */
export type BrowserSource = Extract<LocalMicSource, { kind: "browser" }>;

/** The bridge variant of a Local mic's source. */
export type BridgeSource = Extract<LocalMicSource, { kind: "bridge" }>;

/** One channel that is a Local mic, kept or new, from either source. */
export interface LocalMicChannel {
  localMicId: string;
  source: LocalMicSource;
}

/** One channel of a Stage-browser device: a Local mic, kept or new. */
export interface BrowserChannel extends LocalMicChannel {
  source: BrowserSource;
}

// Chromium lists these as copies of a real device.
const ALIASES = new Set(["default", "communications"]);

/**
 * The audio inputs of `enumerateDevices()`, without Chromium's `default` and
 * `communications` entries. Before the page may read the microphone the ids
 * are empty, and there is nothing to list.
 */
export function browserInputDevices(
  devices: readonly Pick<MediaDeviceInfo, "deviceId" | "label" | "kind">[],
): BrowserDevice[] {
  return devices
    .filter(
      (d) =>
        d.kind === "audioinput" &&
        d.deviceId !== "" &&
        !ALIASES.has(d.deviceId),
    )
    .map(({ deviceId, label }) => ({ deviceId, label }));
}

/** The Local mic id of a Stage-browser channel. */
export function browserLocalMicId(
  stageBrowser: string,
  deviceId: string,
  channel: number,
): string {
  return `browser:${stageBrowser}:${deviceId}:${String(channel)}`;
}

/**
 * The Local mics of a device that opened with `channelCount` channels: two
 * (Left, Right) for a stereo device, one for a mono device.
 */
export function browserChannels(
  stageBrowser: string,
  device: BrowserDevice,
  channelCount: number,
): BrowserChannel[] {
  const stereo = channelCount >= 2;
  return (stereo ? [0, 1] : [0]).map((channel) => ({
    localMicId: browserLocalMicId(stageBrowser, device.deviceId, channel),
    source: {
      kind: "browser",
      stageBrowser,
      deviceId: device.deviceId,
      label: device.label,
      channel,
      stereo,
    },
  }));
}

/**
 * The name a Local mic shows: the host's, or for an empty stored name the
 * default: "<label> · Left" / "<label> · Right" for a stereo channel, the
 * plain label for a mono device, "<device> · Input n" (n from 1) for a
 * bridge channel.
 */
export function localMicName(source: LocalMicSource, name: string): string {
  if (name !== "") return name;
  const { label } = source;
  if (source.kind === "bridge")
    return t("mics.localMic.input", {
      device: label,
      number: source.channel + 1,
    });
  if (!source.stereo) return t("mics.localMic.mono", { label });
  return source.channel === 0
    ? t("mics.localMic.left", { label })
    : t("mics.localMic.right", { label });
}

/** Devices by name (their label), channels by number. */
export function micsScreenOrder<C extends BrowserChannel>(
  channels: readonly C[],
): C[] {
  return [...channels].sort(
    (a, b) =>
      a.source.label.localeCompare(b.source.label) ||
      a.source.deviceId.localeCompare(b.source.deviceId) ||
      a.source.channel - b.source.channel,
  );
}

/**
 * The devices the Stage browser keeps open: every device with a switched-on
 * Local mic of this Stage browser, and while the Mics screen is open every
 * device, for its meters.
 */
export function devicesToOpen({
  stageBrowser,
  devices,
  kept,
  micsScreenOpen,
}: {
  stageBrowser: string;
  devices: readonly BrowserDevice[];
  kept: readonly LocalMic[];
  micsScreenOpen: boolean;
}): Set<string> {
  const on = new Set(
    kept.flatMap(({ switchedOn, source }) =>
      switchedOn &&
      source.kind === "browser" &&
      source.stageBrowser === stageBrowser
        ? [source.deviceId]
        : [],
    ),
  );
  return new Set(
    devices
      .filter((d) => micsScreenOpen || on.has(d.deviceId))
      .map((d) => d.deviceId),
  );
}

/**
 * The rows of a bridge's group on the Mics screen: an open bridge's
 * channels, a closed bridge's kept Local mics; devices by name, channels by
 * number.
 */
export function bridgeGroupChannels(
  bridge: MicBridge,
  kept: readonly LocalMic[],
): LocalMicChannel[] {
  const channels: { localMicId: string; source: BridgeSource }[] = (
    bridge.open ? bridge.channels : kept
  ).flatMap(({ localMicId, source }) =>
    source.kind === "bridge" && source.bridgeId === bridge.bridgeId
      ? [{ localMicId, source }]
      : [],
  );
  return channels.sort(
    (a, b) =>
      a.source.label.localeCompare(b.source.label) ||
      a.source.deviceName.localeCompare(b.source.deviceName) ||
      a.source.channel - b.source.channel,
  );
}

const STAGE_BROWSER_KEY = "openstar.stageBrowser";

let pageOnlyId: string | null = null;

/**
 * This browser's id as a Stage: made at random once and kept in local
 * storage, like a Phone id. Clearing site data makes a new one (and Chromium
 * new `deviceId`s with it).
 */
export function stageBrowserId(
  storage: Pick<Storage, "getItem" | "setItem">,
  makeId: () => string = randomId,
): string {
  try {
    const keptId = storage.getItem(STAGE_BROWSER_KEY);
    if (keptId) return keptId;
    const made = makeId();
    storage.setItem(STAGE_BROWSER_KEY, made);
    return made;
  } catch {
    pageOnlyId ??= makeId();
    return pageOnlyId;
  }
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
