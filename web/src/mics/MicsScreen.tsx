// The Mics screen (Setup › Mics, v1 spec #51), in groups: This browser
// (every channel the Stage browser can read as a Local mic, each with its
// name, a live level meter and an on/off switch), then each approved Mic
// bridge in order of approval (open or closed, with its channels), then New
// bridges waiting for approval with their code and Approve. Switching and
// approving need no Admin PIN and are saved at once. Every device is open
// while the screen is open. Bridge meters (#152), names and Find it (#122)
// and the Mic threshold line (#172) come later.

import { useEffect, useRef } from "react";

import { t } from "../i18n/t";
import { useLocalMics } from "./LocalMics";
import { SILENCE_DBFS } from "./localMicCapture";
import type { BridgeRequest } from "../generated/BridgeRequest";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridge } from "../generated/MicBridge";
import {
  bridgeGroupChannels,
  browserChannels,
  localMicName,
  micsScreenOrder,
  type LocalMicChannel,
} from "./localMics";

/** The meter's range, in dBFS. */
const METER_FLOOR_DBFS = -60;

/** A channel's live level: redrawn every frame, no React render. */
function LevelMeter({
  read,
  label,
}: {
  read: () => number | null;
  label: string;
}) {
  const meter = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const dbfs = read() ?? SILENCE_DBFS;
      const shown = Math.max(METER_FLOOR_DBFS, Math.min(0, dbfs));
      const fraction = (shown - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS;
      if (fill.current) fill.current.style.width = `${String(fraction * 100)}%`;
      meter.current?.setAttribute("aria-valuenow", String(Math.round(shown)));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [read]);
  return (
    <div
      ref={meter}
      role="meter"
      aria-label={label}
      aria-valuemin={METER_FLOOR_DBFS}
      aria-valuemax={0}
      aria-valuenow={METER_FLOOR_DBFS}
      className="relative h-6 w-[420px] shrink-0 overflow-hidden rounded-full bg-white shadow-ledge-sm"
    >
      <div ref={fill} className="h-full w-0 rounded-full bg-green" />
    </div>
  );
}

function ChannelRow({
  channel,
  name,
  switchedOn,
  read,
  onSwitch,
}: {
  channel: LocalMicChannel;
  name: string;
  switchedOn: boolean;
  /** The live level; a row without one has no meter yet (bridges, #152). */
  read?: () => number | null;
  onSwitch: (on: boolean) => void;
}) {
  return (
    <li
      className="flex items-center gap-8 rounded-card bg-white px-8 py-5"
      data-local-mic={channel.localMicId}
    >
      <span className="min-w-0 flex-1 truncate text-3xl font-semibold">
        {name}
      </span>
      {read && <LevelMeter read={read} label={t("mics.meter", { name })} />}
      <button
        type="button"
        role="switch"
        aria-checked={switchedOn}
        aria-label={t("mics.switch", { name })}
        onClick={() => {
          onSwitch(!switchedOn);
        }}
        className={`inline-flex min-h-14 w-36 shrink-0 cursor-pointer items-center justify-center rounded-full text-2xl font-bold transition ${
          switchedOn
            ? "bg-green text-white shadow-ledge-green"
            : "bg-white text-ink-2 shadow-ledge-sm"
        }`}
      >
        {switchedOn ? t("mics.switchedOn") : t("mics.switchedOff")}
      </button>
    </li>
  );
}

/** An approved bridge's group: open or closed, with its channels. */
function BridgeGroup({
  bridge,
  kept,
  onSwitch,
}: {
  bridge: MicBridge;
  kept: readonly LocalMic[];
  onSwitch: (channel: LocalMicChannel, on: boolean) => void;
}) {
  const keptById = new Map(kept.map((m) => [m.localMicId, m]));
  const channels = bridgeGroupChannels(bridge, kept);
  const heading = `mics-bridge-${bridge.bridgeId}`;
  return (
    <section
      role="group"
      aria-labelledby={heading}
      className="flex flex-col gap-5"
      data-testid="mics-bridge"
    >
      <div className="flex items-baseline justify-between gap-6">
        <h3 id={heading} className="text-3xl font-bold">
          {t("mics.group.bridge", { host: bridge.hostName })}
        </h3>
        <p
          className={`text-2xl font-semibold ${bridge.open ? "text-green" : "text-ink-2"}`}
        >
          {bridge.open ? t("mics.bridge.open") : t("mics.bridge.closed")}
        </p>
      </div>
      {channels.length === 0 && (
        <p className="text-2xl text-ink-2">{t("mics.bridge.noChannels")}</p>
      )}
      <ul className="flex flex-col gap-4">
        {channels.map((channel) => {
          const stored = keptById.get(channel.localMicId);
          return (
            <ChannelRow
              key={channel.localMicId}
              channel={channel}
              name={localMicName(channel.source, stored?.name ?? "")}
              switchedOn={stored?.switchedOn ?? false}
              onSwitch={(on) => {
                onSwitch(channel, on);
              }}
            />
          );
        })}
      </ul>
    </section>
  );
}

/** Bridges waiting for approval, each with its code and Approve. */
function NewBridges({
  requests,
  onApprove,
}: {
  requests: readonly BridgeRequest[];
  onApprove: (requestId: number) => void;
}) {
  return (
    <section
      role="group"
      aria-labelledby="mics-new-bridges"
      className="flex flex-col gap-5"
      data-testid="mics-new-bridges"
    >
      <h3 id="mics-new-bridges" className="text-3xl font-bold">
        {t("mics.group.newBridges")}
      </h3>
      <ul className="flex flex-col gap-4">
        {requests.map(({ requestId, hostName, code }) => (
          <li
            key={requestId}
            className="flex items-center gap-8 rounded-card bg-white px-8 py-5"
          >
            <span className="min-w-0 flex-1 truncate text-3xl font-semibold">
              {t("mics.newBridge", { host: hostName, code })}
            </span>
            <button
              type="button"
              aria-label={t("mics.approveBridge", { host: hostName, code })}
              onClick={() => {
                onApprove(requestId);
              }}
              className="inline-flex min-h-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-green px-10 text-2xl font-bold text-white shadow-ledge-green transition"
            >
              {t("mics.approve")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MicsScreen() {
  const {
    capture,
    snapshot,
    stageBrowser,
    kept,
    setMicsScreenOpen,
    setSwitchedOn,
    bridges,
    approveBridge,
  } = useLocalMics();

  useEffect(() => {
    setMicsScreenOpen(true);
    return () => {
      setMicsScreenOpen(false);
    };
  }, [setMicsScreenOpen]);

  const keptById = new Map(kept.map((m) => [m.localMicId, m]));
  const channels = micsScreenOrder(
    snapshot.devices.flatMap((device) => {
      const count = snapshot.open.get(device.deviceId);
      return count === undefined
        ? []
        : browserChannels(stageBrowser, device, count);
    }),
  );

  let notice: string | null = null;
  if (snapshot.status === "unavailable") notice = t("mics.unavailable");
  else if (snapshot.status === "needsPermission")
    notice = t("mics.allowMicrophone");
  else if (snapshot.status === "ready" && snapshot.devices.length === 0)
    notice = t("mics.noDevices");

  return (
    <div className="flex flex-col gap-10">
      <section
        role="group"
        aria-labelledby="mics-this-browser"
        className="flex flex-col gap-5"
        data-testid="mics-this-browser"
      >
        <div className="flex items-baseline justify-between gap-6">
          <h3 id="mics-this-browser" className="text-3xl font-bold">
            {t("mics.group.thisBrowser")}
          </h3>
          <p className="text-2xl text-ink-2">{t("mics.bridgeHint")}</p>
        </div>
        {notice !== null && <p className="text-2xl text-ink-2">{notice}</p>}
        <ul className="flex flex-col gap-4">
          {channels.map((channel) => {
            const stored = keptById.get(channel.localMicId);
            const { deviceId, channel: number } = channel.source;
            return (
              <ChannelRow
                key={channel.localMicId}
                channel={channel}
                name={localMicName(channel.source, stored?.name ?? "")}
                switchedOn={stored?.switchedOn ?? false}
                read={() => capture?.levelDbfs(deviceId, number) ?? null}
                onSwitch={(on) => {
                  setSwitchedOn(channel, on);
                }}
              />
            );
          })}
        </ul>
      </section>
      {bridges.bridges.map((bridge) => (
        <BridgeGroup
          key={bridge.bridgeId}
          bridge={bridge}
          kept={kept}
          onSwitch={setSwitchedOn}
        />
      ))}
      {bridges.requests.length > 0 && (
        <NewBridges requests={bridges.requests} onApprove={approveBridge} />
      )}
    </div>
  );
}
