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
import { t } from "../i18n/t";

/** An input device the Stage browser can open. */
export interface BrowserDevice {
  deviceId: string;
  label: string;
}

/** The browser variant of a Local mic's source. */
export type BrowserSource = Extract<LocalMicSource, { kind: "browser" }>;

/** One channel of a Stage-browser device: a Local mic, kept or new. */
export interface BrowserChannel {
  localMicId: string;
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
 * plain label for a mono device.
 */
export function localMicName(source: BrowserSource, name: string): string {
  if (name !== "") return name;
  const { label } = source;
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

/** A kept Local mic re-keyed to the channel it now appears on. */
export interface Rekey {
  localMic: LocalMic;
  channel: BrowserChannel;
}

/** How the kept Local mics meet the channels the Stage browser sees. */
export interface LocalMicMatch {
  /** Missing Local mics of this browser found again by exact label + channel. */
  rekeys: Rekey[];
  /** Kept Local mics whose id is not present and that matched nothing. */
  notFound: LocalMic[];
  /** Channels of open devices that are not yet a Local mic, nor re-keyed. */
  newChannels: BrowserChannel[];
}

/**
 * Id matching on the browser path. A kept Local mic is present while its
 * device is listed under its stored `deviceId` (and this Stage browser). If
 * it is not, a Local mic of this Stage browser is matched by exact label and
 * channel, but only when exactly one channel that is not yet a Local mic
 * fits, and no other missing Local mic fits that channel too; it is then
 * re-keyed. Labels are compared exactly, never fuzzily. A decision waits
 * until every device with that label is open (its channel count known).
 */
export function matchLocalMics({
  stageBrowser,
  devices,
  open,
  kept,
}: {
  stageBrowser: string;
  devices: readonly BrowserDevice[];
  /** Channel count of each open device. */
  open: ReadonlyMap<string, number>;
  kept: readonly LocalMic[];
}): LocalMicMatch {
  const keptIds = new Set(kept.map((m) => m.localMicId));
  const listed = new Set(devices.map((d) => d.deviceId));
  const present = (m: LocalMic) =>
    m.source.stageBrowser === stageBrowser && listed.has(m.source.deviceId);
  const unkept = devices.flatMap((device) => {
    const count = open.get(device.deviceId);
    return count === undefined
      ? []
      : browserChannels(stageBrowser, device, count).filter(
          (c) => !keptIds.has(c.localMicId),
        );
  });
  const missing = kept.filter((m) => !present(m));
  const fits = (m: LocalMic, c: BrowserChannel) =>
    m.source.stageBrowser === stageBrowser &&
    c.source.label === m.source.label &&
    c.source.channel === m.source.channel;
  const allOpen = (label: string) =>
    devices.every((d) => d.label !== label || open.has(d.deviceId));

  const rekeys: Rekey[] = [];
  for (const localMic of missing) {
    if (!allOpen(localMic.source.label)) continue;
    const candidates = unkept.filter((c) => fits(localMic, c));
    const [only] = candidates;
    if (
      only !== undefined &&
      candidates.length === 1 &&
      missing.filter((m) => fits(m, only)).length === 1
    )
      rekeys.push({ localMic, channel: only });
  }
  const rekeyed = new Set(rekeys.map((r) => r.localMic.localMicId));
  const taken = new Set(rekeys.map((r) => r.channel.localMicId));
  return {
    rekeys,
    notFound: missing.filter((m) => !rekeyed.has(m.localMicId)),
    newChannels: unkept.filter((c) => !taken.has(c.localMicId)),
  };
}

/**
 * The devices the Stage browser keeps open: every device with a switched-on
 * Local mic of this Stage browser, every device whose label is that of a
 * missing switched-on Local mic of this Stage browser (so it can be
 * re-keyed), and while the Mics screen is open every device, for its meters.
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
  const listed = new Set(devices.map((d) => d.deviceId));
  const on = kept.filter(
    (m) => m.switchedOn && m.source.stageBrowser === stageBrowser,
  );
  const onIds = new Set(on.map((m) => m.source.deviceId));
  const missingLabels = new Set(
    on.filter((m) => !listed.has(m.source.deviceId)).map((m) => m.source.label),
  );
  return new Set(
    devices
      .filter(
        (d) =>
          micsScreenOpen || onIds.has(d.deviceId) || missingLabels.has(d.label),
      )
      .map((d) => d.deviceId),
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
