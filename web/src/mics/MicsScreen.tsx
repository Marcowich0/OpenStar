// The Mics screen (Setup › Mics, v1 spec #51), in groups: This browser
// (every channel the Stage browser can read as a Local mic, each with its
// editable name, a live level meter and an on/off switch, then every kept
// Local mic of this browser whose id is not present as "<name> · not found"
// with Find it), then each approved Mic bridge in order of approval (open or
// closed, with its channels and their editable names, and while open a live
// meter per channel fed by the levels the bridge sends), then New bridges
// waiting for approval with their code and Approve. Naming, switching, Find
// it and approving need no Admin PIN and are saved at once; Forget on a
// bridge group deletes kept data, so it is a guarded press and hold. Every device,
// and every interface of every open bridge, is open while the screen is
// open. The Mic threshold line (#172) comes later.

import { useEffect, useRef, useState } from "react";

import type { BridgeRequest } from "../generated/BridgeRequest";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridge } from "../generated/MicBridge";
import { t } from "../i18n/t";
import { ForgetBridge } from "./ForgetBridge";
import { useLocalMics } from "./LocalMics";
import { SILENCE_DBFS } from "./localMicCapture";
import {
  bridgeGroupChannels,
  browserChannels,
  localMicName,
  micsScreenOrder,
  type BrowserChannel,
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

/**
 * A channel's name, edited in place: empty shows (and keeps) the default.
 * Saved on Enter or when the field loses focus, only if it changed.
 */
function NameField({
  stored,
  defaultName,
  onRename,
}: {
  stored: string;
  defaultName: string;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : stored;
  const save = () => {
    setEditing(false);
    if (draft.trim() !== stored) onRename(draft);
  };
  return (
    <input
      type="text"
      value={shown}
      placeholder={defaultName}
      aria-label={t("mics.name", { name: defaultName })}
      onFocus={() => {
        setDraft(stored);
        setEditing(true);
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
      }}
      onBlur={() => {
        if (editing) save();
      }}
      className="min-w-0 flex-1 truncate rounded-full bg-transparent px-4 py-1 text-3xl font-semibold outline-none placeholder:text-ink focus:bg-cream focus:placeholder:text-mute"
    />
  );
}

function ChannelRow({
  channel,
  stored,
  switchedOn,
  read,
  onSwitch,
  onRename,
}: {
  channel: LocalMicChannel;
  stored: string;
  switchedOn: boolean;
  /** The live level; a row without one has no meter (a closed bridge). */
  read?: (() => number | null) | undefined;
  onSwitch: (on: boolean) => void;
  onRename: (name: string) => void;
}) {
  const defaultName = localMicName(channel.source, "");
  const name = localMicName(channel.source, stored);
  return (
    <li
      className="flex items-center gap-8 rounded-card bg-white px-8 py-5"
      data-local-mic={channel.localMicId}
    >
      <NameField
        stored={stored}
        defaultName={defaultName}
        onRename={onRename}
      />
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
  onRename,
  levelDbfs,
}: {
  bridge: MicBridge;
  kept: readonly LocalMic[];
  onSwitch: (channel: LocalMicChannel, on: boolean) => void;
  onRename: (channel: LocalMicChannel, name: string) => void;
  /** A Local mic's latest level from its bridge. */
  levelDbfs: (localMicId: string) => number | null;
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
      <ForgetBridge bridge={bridge} />
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
              stored={stored?.name ?? ""}
              switchedOn={stored?.switchedOn ?? false}
              // A closed bridge sends nothing: its rows have no meter.
              read={
                bridge.open ? () => levelDbfs(channel.localMicId) : undefined
              }
              onSwitch={(on) => {
                onSwitch(channel, on);
              }}
              onRename={(name) => {
                onRename(channel, name);
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

/** A kept Local mic whose id is not present, with Find it. */
function NotFoundRow({
  localMic,
  newChannels,
  onRelink,
}: {
  localMic: LocalMic;
  newChannels: readonly BrowserChannel[];
  onRelink: (channel: BrowserChannel) => void;
}) {
  const [finding, setFinding] = useState(false);
  const name = localMicName(localMic.source, localMic.name);
  return (
    <li
      className="flex flex-col gap-4 rounded-card bg-white px-8 py-5"
      data-local-mic={localMic.localMicId}
    >
      <div className="flex items-center gap-8">
        <span className="min-w-0 flex-1 truncate text-3xl font-semibold text-ink-2">
          {t("mics.notFound", { name })}
        </span>
        <button
          type="button"
          aria-expanded={finding}
          aria-label={t("mics.findIt.label", { name })}
          onClick={() => {
            setFinding(!finding);
          }}
          className="inline-flex min-h-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white px-8 text-2xl font-bold shadow-ledge-sm"
        >
          {t("mics.findIt")}
        </button>
      </div>
      {finding &&
        (newChannels.length === 0 ? (
          <p className="text-2xl text-ink-2">{t("mics.findIt.none")}</p>
        ) : (
          <div
            role="group"
            aria-label={t("mics.findIt.choose", { name })}
            className="flex flex-wrap gap-4"
          >
            {newChannels.map((channel) => (
              <button
                key={channel.localMicId}
                type="button"
                onClick={() => {
                  setFinding(false);
                  onRelink(channel);
                }}
                className="inline-flex min-h-14 cursor-pointer items-center rounded-full bg-cream px-6 text-2xl font-semibold shadow-ledge-sm"
              >
                {localMicName(channel.source, "")}
              </button>
            ))}
          </div>
        ))}
    </li>
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
    match,
    rename,
    relink,
    bridgeLevelDbfs,
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
                stored={stored?.name ?? ""}
                switchedOn={stored?.switchedOn ?? false}
                read={() => capture?.levelDbfs(deviceId, number) ?? null}
                onSwitch={(on) => {
                  setSwitchedOn(channel, on);
                }}
                onRename={(name) => {
                  rename(channel, name);
                }}
              />
            );
          })}
          {match.notFound.map((localMic) => (
            <NotFoundRow
              key={localMic.localMicId}
              localMic={localMic}
              newChannels={micsScreenOrder(match.newChannels)}
              onRelink={(channel) => {
                relink(localMic.localMicId, channel);
              }}
            />
          ))}
        </ul>
      </section>
      {bridges.bridges.map((bridge) => (
        <BridgeGroup
          key={bridge.bridgeId}
          bridge={bridge}
          kept={kept}
          onSwitch={setSwitchedOn}
          onRename={rename}
          levelDbfs={bridgeLevelDbfs}
        />
      ))}
      {bridges.requests.length > 0 && (
        <NewBridges requests={bridges.requests} onApprove={approveBridge} />
      )}
    </div>
  );
}
