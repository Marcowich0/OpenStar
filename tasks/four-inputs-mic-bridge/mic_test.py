#!/usr/bin/env python3
"""OpenStar hardware check: four inputs through one native PipeWire stream.

Wayfinder ticket "Four inputs through the mic bridge"
(https://github.com/Marcowich0/OpenStar/issues/38). Run it on the Linux PC that will be
the Stage, with the audio interface plugged in:

    python3 mic_test.py

It only needs Python 3.9+ and the PipeWire command-line tools (pw-dump, pw-record,
pw-play; pactl is used if present). Nothing is installed and nothing is sent anywhere.
It guides you step by step and writes a folder with report.md, results.json and short
WAV recordings. Send back report.md.

Options: --out DIR, --source NODE_NAME, --short (shorter recordings, for a dry run).
"""

from __future__ import annotations

import argparse
import array
import datetime as dt
import http.server
import json
import math
import os
import platform
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

RATE = 48000
WIN = 2048  # McLeod Pitch Method window in OpenStar: one "reading" = RMS over 2048 samples
HOP = 1024
FALLBACK_GATE = -30.0  # dBFS, from "From Pitch readings to a beat's value"
GATE_MARGIN = 6.0  # dB above the bleed level
INTERFACE_HINT = re.compile(r"scarlett|focusrite|umc|behringer|u-phoria", re.I)
FLOOR_DB = -150.0

# ----------------------------------------------------------------------------- terminal

USE_COLOUR = sys.stdout.isatty()


def c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if USE_COLOUR else s


def h1(s: str) -> None:
    print("\n" + c("1;35", "━" * 72) + "\n" + c("1;35", "  " + s) + "\n" + c("1;35", "━" * 72))


def say(s: str = "") -> None:
    print(s, flush=True)


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        ans = input(c("1;36", f"› {prompt}{suffix}: ")).strip()
    except EOFError:
        ans = ""
    return ans or default


def yes(prompt: str, default: bool = True) -> bool:
    d = "Y/n" if default else "y/N"
    ans = ask(f"{prompt} ({d})").lower()
    return default if not ans else ans.startswith("y")


def wait_enter(prompt: str = "Press Enter to start, or type s and Enter to skip") -> bool:
    ans = ask(prompt).lower()
    return not ans.startswith("s")


def run(cmd: list[str], timeout: float = 15) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def db(x: float) -> float:
    return 20 * math.log10(x) if x > 0 else FLOOR_DB


def fmt_db(x: float | None) -> str:
    if x is None:
        return "–"
    return "silent" if x <= FLOOR_DB + 1 else f"{x:.1f}"


# ----------------------------------------------------------------------------- PipeWire inventory


def pw_dump() -> list[dict]:
    out = run(["pw-dump"], timeout=20)
    try:
        return json.loads(out) if out else []
    except json.JSONDecodeError:
        return []


def props(obj: dict) -> dict:
    return (obj.get("info") or {}).get("props") or {}


def params(obj: dict, name: str) -> list:
    return ((obj.get("info") or {}).get("params") or {}).get(name) or []


def node_channels(node: dict) -> tuple[int, list[str]]:
    p = props(node)
    pos = p.get("audio.position")
    if isinstance(pos, str):
        pos = [x.strip() for x in pos.replace("[", "").replace("]", "").split(",") if x.strip()]
    for fmt in params(node, "Format") + params(node, "EnumFormat"):
        if not pos and isinstance(fmt.get("position"), list):
            pos = fmt["position"]
        ch = fmt.get("channels")
        if isinstance(ch, int) and not p.get("audio.channels"):
            p = dict(p, **{"audio.channels": ch})
    n = p.get("audio.channels")
    try:
        n = int(n)
    except (TypeError, ValueError):
        n = len(pos) if pos else 0
    if not pos or len(pos) != n:
        pos = [f"AUX{i}" for i in range(n)]
    return n, list(pos)


def sources(dump: list[dict]) -> list[dict]:
    res = []
    for o in dump:
        if o.get("type") != "PipeWire:Interface:Node":
            continue
        p = props(o)
        mc = p.get("media.class", "")
        if not mc.startswith("Audio/Source") or p.get("node.name", "").startswith("openstar-"):
            continue
        n, pos = node_channels(o)
        res.append(
            {
                "id": o["id"],
                "serial": p.get("object.serial"),
                "name": p.get("node.name", ""),
                "description": p.get("node.description") or p.get("node.nick") or p.get("node.name", ""),
                "media_class": mc,
                "channels": n,
                "positions": pos,
                "device_id": p.get("device.id"),
                "props": {k: v for k, v in p.items() if k.startswith(("node.", "api.alsa", "audio.", "device.", "media.", "object.serial", "priority"))},
            }
        )
    return res


def device(dump: list[dict], dev_id) -> dict | None:
    for o in dump:
        if o.get("type") == "PipeWire:Interface:Device" and o.get("id") == dev_id:
            return o
    return None


def profiles(dev: dict) -> tuple[dict | None, list[dict]]:
    active = (params(dev, "Profile") or [None])[0]
    enum = params(dev, "EnumProfile")
    return active, enum


def profile_has_input(p: dict) -> bool:
    classes = p.get("classes")
    if isinstance(classes, list):
        txt = json.dumps(classes)
        m = re.search(r'"Audio/Source",\s*(\d+)', txt)
        if m:
            return int(m.group(1)) > 0
    name = (p.get("name") or "").lower()
    return name == "pro-audio" or "input" in name


def set_profile(dev: dict, prof: dict) -> bool:
    dev_name = props(dev).get("device.name")
    if shutil.which("pactl") and dev_name and prof.get("name"):
        r = subprocess.run(["pactl", "set-card-profile", dev_name, prof["name"]], capture_output=True)
        if r.returncode == 0:
            return True
    if shutil.which("wpctl") and "index" in prof:
        r = subprocess.run(["wpctl", "set-profile", str(dev["id"]), str(prof["index"])], capture_output=True)
        return r.returncode == 0
    return False


def wait_for_source(dev_id, timeout: float = 6.0) -> dict | None:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        time.sleep(0.5)
        for s in sources(pw_dump()):
            if s["device_id"] == dev_id:
                time.sleep(0.5)  # let the node settle
                for s2 in sources(pw_dump()):
                    if s2["device_id"] == dev_id:
                        return s2
    return None


def system_facts() -> dict:
    facts = {"date": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "python": platform.python_version(), "kernel": platform.release()}
    try:
        osr = Path("/etc/os-release").read_text()
        m = re.search(r'^PRETTY_NAME="?([^"\n]*)', osr, re.M)
        facts["os"] = m.group(1) if m else ""
    except OSError:
        pass
    facts["pipewire"] = (run(["pipewire", "--version"]) or run(["pw-cli", "--version"])).strip().replace("\n", " | ")
    facts["wireplumber"] = run(["wireplumber", "--version"]).strip().replace("\n", " | ")
    info = run(["pactl", "info"])
    m = re.search(r"Server Name: (.*)", info)
    facts["pulse_server"] = m.group(1).strip() if m else ""
    meta = run(["pw-metadata", "-n", "settings"])
    for key in ("clock.rate", "clock.quantum", "clock.min-quantum", "clock.max-quantum", "clock.force-quantum", "clock.force-rate"):
        m = re.search(rf"key:'{re.escape(key)}' value:'([^']*)'", meta)
        if m:
            facts[key] = m.group(1)
    facts["chromium"] = find_chromium()[1]
    return facts


def find_chromium() -> tuple[list[str] | None, str]:
    for b in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "microsoft-edge"):
        if shutil.which(b):
            return [b], run([b, "--version"]).strip() or b
    if shutil.which("flatpak"):
        apps = run(["flatpak", "list", "--app", "--columns=application,version"])
        for app in ("org.chromium.Chromium", "com.google.Chrome", "com.brave.Browser"):
            m = re.search(rf"^{re.escape(app)}\s+(\S*)", apps, re.M)
            if m:
                return ["flatpak", "run", app], f"{app} {m.group(1)} (flatpak)"
    return None, "not found"


def alsa_facts(src: dict) -> dict:
    out = {}
    card = src["props"].get("api.alsa.card")
    try:
        out["cards"] = Path("/proc/asound/cards").read_text().strip()
    except OSError:
        pass
    if card is not None:
        for f in ("stream0", "usbid", "usbbus"):
            try:
                out[f] = Path(f"/proc/asound/card{card}/{f}").read_text().strip()
            except OSError:
                pass
    return out


# ----------------------------------------------------------------------------- recording


class Recording:
    def __init__(self, nch: int):
        self.nch = nch
        self.raw = bytearray()
        self.started = 0.0
        self.elapsed = 0.0
        self.linked_to_target: bool | None = None
        self.stderr = ""

    def channels(self) -> list[array.array]:
        n = len(self.raw) // 4 // self.nch * self.nch
        a = array.array("i")
        a.frombytes(bytes(self.raw[: n * 4]))
        if sys.byteorder != "little":
            a.byteswap()
        return [a[i :: self.nch] for i in range(self.nch)]

    @property
    def seconds(self) -> float:
        return len(self.raw) / 4 / self.nch / RATE

    def save(self, path: Path) -> None:
        with wave.open(str(path), "wb") as w:
            w.setnchannels(self.nch)
            w.setsampwidth(4)
            w.setframerate(RATE)
            w.writeframes(bytes(self.raw[: len(self.raw) // (4 * self.nch) * 4 * self.nch]))


def check_link(target_id: int) -> bool | None:
    dump = pw_dump()
    ours = {o["id"] for o in dump if o.get("type") == "PipeWire:Interface:Node" and props(o).get("node.name") == "openstar-mic-test"}
    if not ours:
        return None
    for o in dump:
        if o.get("type") == "PipeWire:Interface:Link":
            i = o.get("info") or {}
            if i.get("input-node-id") in ours and i.get("output-node-id") == target_id:
                return True
    return False


def record(src: dict, seconds: float, meter: bool = True, until_enter: bool = False) -> Recording:
    """Record every channel of `src` as ONE PipeWire stream (pw-record, raw s32 to stdout)."""
    nch = src["channels"]
    cmd = [
        "pw-record", "--target", str(src["name"]), "--rate", str(RATE), "--channels", str(nch),
        "--channel-map", ",".join(src["positions"]), "--format", "s32", "--raw",
        "-P", "{ node.name = openstar-mic-test stream.dont-remix = true node.dont-reconnect = true }", "-",
    ]
    rec = Recording(nch)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    rec.started = time.monotonic()
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    frame_bytes = 4 * nch
    last_meter = 0.0
    link_checked = False
    peak_hold = [FLOOR_DB] * nch
    try:
        while True:
            now = time.monotonic()
            t = now - rec.started
            if not until_enter and t >= seconds:
                break
            r, _, _ = select.select([fd] + ([sys.stdin] if until_enter else []), [], [], 0.05)
            if fd in r:
                try:
                    chunk = os.read(fd, 1 << 16)
                except BlockingIOError:
                    chunk = b""
                if not chunk and proc.poll() is not None:
                    break
                rec.raw.extend(chunk)
            if until_enter and sys.stdin in r:
                sys.stdin.readline()
                break
            if not link_checked and t > 0.7:
                rec.linked_to_target = check_link(src["id"])
                link_checked = True
            if meter and now - last_meter > 0.1 and len(rec.raw) >= frame_bytes * 4800:
                last_meter = now
                end = len(rec.raw) // frame_bytes * frame_bytes
                tail = rec.raw[max(0, end - frame_bytes * 4800) : end]
                a = array.array("i")
                a.frombytes(bytes(tail))
                line = []
                for ch in range(nch):
                    xs = a[ch::nch]
                    pk = max((abs(v) for v in xs), default=0) / 2147483648.0
                    rms = math.sqrt(sum(v * v for v in xs) / max(len(xs), 1)) / 2147483648.0
                    peak_hold[ch] = max(peak_hold[ch] - 1.5, db(pk))
                    line.append(bar(db(rms), peak_hold[ch], ch + 1))
                clock = f"{t:4.1f}s" if until_enter else f"{max(seconds - t, 0):4.1f}s left"
                sys.stdout.write("\r" + "  ".join(line) + "  " + clock + " ")
                sys.stdout.flush()
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            rest, err = proc.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            rest, err = proc.communicate()
        rec.raw.extend(rest or b"")
        rec.stderr = (err or b"").decode(errors="replace")[-2000:]
        rec.elapsed = time.monotonic() - rec.started
        if meter:
            sys.stdout.write("\n")
    if not rec.raw:
        say(c("1;31", "  pw-record returned no audio. Its error output:"))
        say(rec.stderr or "  (none)")
    return rec


def bar(rms_db: float, peak_db: float, n: int, width: int = 10) -> str:
    lo, hi = -72.0, 0.0
    fill = int(round((min(max(rms_db, lo), hi) - lo) / (hi - lo) * width))
    s = "█" * fill + "·" * (width - fill)
    col = "32" if peak_db < -6 else ("33" if peak_db < -1 else "31")
    return f"{n}:{c(col, s)}{fmt_db(peak_db):>6}"


# ----------------------------------------------------------------------------- analysis


def frame_rms_db(xs: array.array) -> list[float]:
    out = []
    scale = 1 / 2147483648.0
    for i in range(0, len(xs) - WIN + 1, HOP):
        seg = xs[i : i + WIN]
        s = math.fsum(v * v for v in seg)
        out.append(db(math.sqrt(s / WIN) * scale))
    return out


def pct(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    v = sorted(vals)
    k = (len(v) - 1) * p / 100
    f = math.floor(k)
    cl = min(f + 1, len(v) - 1)
    return v[f] + (v[cl] - v[f]) * (k - f)


def zc_freq(xs: array.array) -> float | None:
    if len(xs) < RATE // 4:
        return None
    seg = xs[len(xs) // 4 : len(xs) // 4 + RATE // 2]
    mean = sum(seg) / len(seg)
    crossings = sum(1 for a, b in zip(seg, seg[1:]) if (a - mean < 0) != (b - mean < 0))
    return crossings / 2 / (len(seg) / RATE)


def channel_stats(xs: array.array) -> dict:
    n = len(xs)
    if n == 0:
        return {"samples": 0}
    scale = 1 / 2147483648.0
    rms = math.sqrt(math.fsum(v * v for v in xs) / n) * scale
    peak = max(max(xs), -min(xs)) * scale
    zeros = xs.count(0)
    longest = run_len = 0
    for v in xs:
        if v == 0:
            run_len += 1
            if run_len > longest:
                longest = run_len
        else:
            run_len = 0
    frames = frame_rms_db(xs)
    clip = sum(1 for v in xs if abs(v) >= 2147000000)
    return {
        "samples": n,
        "rms_db": round(db(rms), 1),
        "peak_db": round(db(peak), 1),
        "zero_share": round(zeros / n, 4),
        "longest_zero_run_s": round(longest / RATE, 3),
        "clipped_samples": clip,
        "frame_p05": rnd(pct(frames, 5)),
        "frame_p50": rnd(pct(frames, 50)),
        "frame_p95": rnd(pct(frames, 95)),
        "frame_max": rnd(max(frames) if frames else None),
        "zc_hz": rnd(zc_freq(xs), 0),
        "_frames": frames,
    }


def as_int(s, default: int) -> int:
    m = re.search(r"\d+", str(s or ""))
    return int(m.group()) if m else default


def rnd(x, d=1):
    return None if x is None else round(x, d)


def analyse(rec: Recording) -> dict:
    chans = rec.channels()
    return {
        "seconds_received": round(rec.seconds, 2),
        "seconds_elapsed": round(rec.elapsed, 2),
        "linked_to_target": rec.linked_to_target,
        "channels": [channel_stats(x) for x in chans],
    }


def strip_frames(d):
    if isinstance(d, dict):
        return {k: strip_frames(v) for k, v in d.items() if not k.startswith("_")}
    if isinstance(d, list):
        return [strip_frames(v) for v in d]
    return d


# ----------------------------------------------------------------------------- tones


def write_tones(path: Path, rms_dbfs: float = -18.0) -> list[tuple[float, float]]:
    """8 tones of 400 ms, 300 ms apart, at known pitches (a stand-in for Calibrate mics)."""
    freqs = [220.0, 293.66, 349.23, 440.0, 523.25, 392.0, 329.63, 261.63]
    amp = 10 ** (rms_dbfs / 20) * math.sqrt(2)
    tone_len, gap = int(0.4 * RATE), int(0.3 * RATE)
    data = array.array("h")
    marks = []
    data.extend([0] * int(0.5 * RATE))
    for f in freqs:
        start = len(data) / RATE
        for i in range(tone_len):
            env = min(1.0, i / 480, (tone_len - i) / 480)
            data.append(int(32767 * amp * env * math.sin(2 * math.pi * f * i / RATE)))
        marks.append((start, start + tone_len / RATE))
        data.extend([0] * gap)
    data.extend([0] * int(0.5 * RATE))
    if sys.byteorder != "little":
        data.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())
    return marks


def write_stereo_test(path: Path) -> None:
    """60 s line-level test signal: left 440 Hz, right 660 Hz, at -12 dBFS."""
    amp = 10 ** (-12 / 20) * math.sqrt(2)
    n = 60 * RATE
    data = array.array("h", [0]) * (2 * n)
    for i in range(n):
        data[2 * i] = int(32767 * amp * math.sin(2 * math.pi * 440 * i / RATE))
        data[2 * i + 1] = int(32767 * amp * math.sin(2 * math.pi * 660 * i / RATE))
    if sys.byteorder != "little":
        data.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())


def sinks() -> list[dict]:
    res = []
    for o in pw_dump():
        if o.get("type") != "PipeWire:Interface:Node":
            continue
        p = props(o)
        if p.get("media.class") == "Audio/Sink":
            res.append({"id": o["id"], "name": p.get("node.name", ""), "description": p.get("node.description", "")})
    return res


# ----------------------------------------------------------------------------- browser page

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenStar browser mic check</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#fff7ec;--ink:#2b2340;--pink:#ff5d8f;--sky:#3fa9f5;--mint:#2ec4a6;--card:#fff}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:28px;margin:0 0 8px}
.card{background:var(--card);border:3px solid var(--ink);border-radius:22px;padding:18px 20px;margin:16px 0;box-shadow:0 5px 0 var(--ink)}
button,select{font:inherit;border:3px solid var(--ink);border-radius:999px;padding:8px 18px;background:var(--pink);color:#fff;font-weight:700;cursor:pointer}
select{background:#fff;color:var(--ink);max-width:100%}
button:disabled{opacity:.4;cursor:default}
.meter{display:flex;align-items:center;gap:12px;margin:10px 0}
.meter b{width:120px}
.track{flex:1;height:26px;border:3px solid var(--ink);border-radius:999px;overflow:hidden;background:#eee}
.fill{height:100%;width:0;background:var(--mint);transition:width .05s}
.val{width:90px;text-align:right;font-variant-numeric:tabular-nums}
#step{font-size:22px;font-weight:700;min-height:2em}
pre{white-space:pre-wrap;font-size:13px;background:#f4efe6;border-radius:12px;padding:10px}
</style></head><body><main>
<h1>Browser mic check</h1>
<p>This page opens your interface the way the Stage browser would (echo cancellation, noise
suppression and auto gain <b>off</b>, 2 channels) and checks which input reaches which channel.</p>
<div class="card">
  <p><button id="perm">1. Allow the microphone</button></p>
  <p><select id="dev" disabled><option>Choose the interface after step 1</option></select></p>
  <p><button id="start" disabled>2. Start the guided check</button></p>
</div>
<div class="card">
  <div id="step">Waiting…</div>
  <div class="meter"><b>Channel 1 (L)</b><div class="track"><div class="fill" id="f0"></div></div><span class="val" id="v0">–</span></div>
  <div class="meter"><b>Channel 2 (R)</b><div class="track"><div class="fill" id="f1"></div></div><span class="val" id="v1">–</span></div>
</div>
<div class="card"><pre id="log"></pre></div>
</main><script>
const PHASES = __PHASES__;
const $ = id => document.getElementById(id);
const log = s => { $('log').textContent += s + '\n'; };
let devices = [];
$('perm').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({audio: true});
    s.getTracks().forEach(t => t.stop());
  } catch (e) { log('Permission failed: ' + e); return; }
  devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  const sel = $('dev'); sel.innerHTML = '';
  for (const d of devices) {
    const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || d.deviceId;
    if (/__HINT__/i.test(d.label) && !sel.dataset.picked) { o.selected = true; sel.dataset.picked = 1; }
    sel.appendChild(o);
  }
  sel.disabled = false; $('start').disabled = false;
  log('Input devices: ' + devices.map(d => `${d.label} [${d.deviceId.slice(0, 8)}]`).join(' | '));
};
const dbfs = x => x > 0 ? 20 * Math.log10(x) : -150;
const pct = (a, p) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor((v.length - 1) * p / 100))]; };
$('start').onclick = async () => {
  $('start').disabled = true;
  const deviceId = $('dev').value;
  const dev = devices.find(d => d.deviceId === deviceId);
  const result = {userAgent: navigator.userAgent, label: dev && dev.label, deviceIdPrefix: deviceId.slice(0, 12), phases: []};
  let stream;
  const constraints = {audio: {deviceId: {exact: deviceId}, channelCount: {ideal: 2},
    echoCancellation: false, noiseSuppression: false, autoGainControl: false}};
  try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) { result.error = String(e); log('getUserMedia failed: ' + e); await send(result); return; }
  const track = stream.getAudioTracks()[0];
  result.settings = track.getSettings();
  try { result.capabilities = track.getCapabilities(); } catch (e) {}
  try { if (dev && dev.getCapabilities) result.deviceCapabilities = dev.getCapabilities(); } catch (e) {}
  log('settings: ' + JSON.stringify(result.settings));
  const ctx = new AudioContext({latencyHint: 'interactive'});
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  result.sourceChannelCount = src.channelCount;
  result.contextSampleRate = ctx.sampleRate;
  const split = ctx.createChannelSplitter(2);
  src.connect(split);
  const an = [0, 1].map(i => { const a = ctx.createAnalyser(); a.fftSize = 2048; split.connect(a, i); return a; });
  const buf = new Float32Array(2048);
  let current = null;
  const tick = () => {
    for (let i = 0; i < 2; i++) {
      an[i].getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v;
      const d = dbfs(Math.sqrt(s / buf.length));
      $('f' + i).style.width = Math.max(0, Math.min(100, (d + 72) / 72 * 100)) + '%';
      $('v' + i).textContent = d <= -149 ? 'silent' : d.toFixed(1) + ' dB';
      if (current) current.frames[i].push(d);
    }
  };
  const timer = setInterval(tick, 43);
  for (const ph of PHASES) {
    for (let k = 3; k > 0; k--) { $('step').textContent = `Next: ${ph.text} (starts in ${k})`; await sleep(1000); }
    $('step').textContent = `Now: ${ph.text}`;
    current = {key: ph.key, text: ph.text, frames: [[], []]};
    await sleep(ph.seconds * 1000);
    const summary = {key: ph.key, text: ph.text, ch: current.frames.map(f => ({p50: pct(f, 50), p95: pct(f, 95), max: pct(f, 100), n: f.length}))};
    result.phases.push(summary);
    log(`${ph.key}: ch1 p50 ${summary.ch[0].p50?.toFixed(1)} dB, ch2 p50 ${summary.ch[1].p50?.toFixed(1)} dB`);
    current = null;
  }
  clearInterval(timer);
  result.trackStateAtEnd = {readyState: track.readyState, muted: track.muted};
  stream.getTracks().forEach(t => t.stop());
  await ctx.close();
  $('step').textContent = 'Done. You can close this tab and go back to the terminal.';
  await send(result);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function send(result) {
  try { await fetch('/result', {method: 'POST', body: JSON.stringify(result)}); log('Results sent to the terminal.'); }
  catch (e) { log('Could not send results: ' + e + '\nCopy this text into the terminal folder as browser.json:\n' + JSON.stringify(result)); }
}
</script></body></html>
"""


def browser_check(phases: list[dict], timeout: float = 600) -> dict | None:
    got: dict = {}
    done = threading.Event()
    page = PAGE.replace("__PHASES__", json.dumps(phases)).replace("__HINT__", INTERFACE_HINT.pattern)

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = page.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("Content-Length", 0))
            try:
                got.update(json.loads(self.rfile.read(n)))
            except json.JSONDecodeError:
                pass
            self.send_response(204)
            self.end_headers()
            done.set()

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("OPENSTAR_PORT", "0"))), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://localhost:{port}/"
    exe, ver = find_chromium()
    say(f"  Page: {c('1', url)}   (localhost counts as a secure origin, so no HTTPS is needed)")
    if os.environ.get("OPENSTAR_NO_BROWSER_LAUNCH"):
        pass
    elif exe and yes(f"Open it in {ver} now?", True):
        subprocess.Popen(exe + ["--new-window", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        say("  Open that address in Chromium (or Chrome) yourself.")
    say("  Follow the page. The terminal waits for its results (press Enter here to give up).")
    t0 = time.monotonic()
    while not done.is_set() and time.monotonic() - t0 < timeout:
        r, _, _ = select.select([sys.stdin], [], [], 0.5) if sys.stdin.isatty() else ([], [], time.sleep(0.5))
        if r:
            sys.stdin.readline()
            break
    srv.shutdown()
    return got or None


# ----------------------------------------------------------------------------- the guided run


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--source", help="PipeWire node.name of the interface (skips the picker)")
    ap.add_argument("--short", action="store_true", help="short recordings, for a dry run")
    args = ap.parse_args()
    S = (lambda s: max(2.0, s / 4)) if args.short else (lambda s: s)

    for tool in ("pw-dump", "pw-record"):
        if not shutil.which(tool):
            say(f"Missing `{tool}`. Install your distribution's PipeWire tools (pipewire-bin / pipewire-utils / pipewire).")
            return 1
    out = args.out or Path.home() / f"openstar-mic-test-{dt.datetime.now():%Y%m%d-%H%M%S}"
    out.mkdir(parents=True, exist_ok=True)
    R: dict = {"ticket": "https://github.com/Marcowich0/OpenStar/issues/38", "script_version": 1}

    h1("OpenStar · four inputs through one stream")
    say("This takes about 15 minutes. You need: the interface plugged in, one or two SM58s with")
    say("XLR cables, a line source with a cable into inputs 3 and 4 (a phone's or laptop's")
    say("headphone output, or the interface's own line outputs), speakers, and a song to play.")
    say(f"Results go to {c('1', str(out))}")

    # ---- 1. inventory
    h1("1 · What PipeWire sees")
    R["system"] = system_facts()
    for k, v in R["system"].items():
        say(f"  {k:18} {v}")
    dump = pw_dump()
    srcs = sources(dump)
    if not srcs:
        say(c("1;31", "No audio inputs found in PipeWire. Is the interface plugged in and switched on?"))
        return 1
    pick = None
    if args.source:
        pick = next((s for s in srcs if s["name"] == args.source), None)
    if not pick:
        say("\n  Audio inputs:")
        for i, s in enumerate(srcs, 1):
            say(f"   {i}. {s['description']}  ·  {s['channels']} ch {','.join(s['positions'])}  ·  {s['name']}")
        guess = next((i for i, s in enumerate(srcs, 1) if INTERFACE_HINT.search(s["description"] + s["name"])), 1)
        pick = srcs[int(ask("Which one is the interface?", str(guess))) - 1]
    src = pick
    dev = device(dump, src["device_id"])
    orig_profile = None
    R["source_initial"] = {k: v for k, v in src.items() if k != "props"}
    R["source_props"] = src["props"]
    R["alsa"] = alsa_facts(src)
    if dev:
        dp = props(dev)
        R["device"] = {k: v for k, v in dp.items() if k.startswith(("device.", "api.alsa", "alsa.", "api.acp"))}
        orig_profile, enum = profiles(dev)
        R["profile_initial"] = orig_profile and {k: orig_profile.get(k) for k in ("index", "name", "description")}
        R["profiles_available"] = [{k: p.get(k) for k in ("index", "name", "description", "available")} for p in enum]
        say(f"\n  Device: {dp.get('device.description')}  ({dp.get('device.name')})")
        say(f"  Active profile: {c('1', (orig_profile or {}).get('description', '?'))}  [{(orig_profile or {}).get('name', '?')}]")
        say("  Profiles with inputs: " + ", ".join(p.get("description", p.get("name", "?")) for p in enum if profile_has_input(p)))
    else:
        say(c("33", "  No PipeWire device behind this input (virtual source?). Profiles are skipped."))
        enum = []
    say(f"  Input node: {src['name']}  ·  {c('1', str(src['channels']))} channels  ·  positions {','.join(src['positions'])}")

    # ---- 1b. channel count in every input profile (no sound needed)
    R["profile_survey"] = []
    if dev and enum and yes("Survey the channel count of every input profile? It switches profiles for a few seconds and switches back", True):
        for p in enum:
            if not profile_has_input(p) or p.get("available") == "no":
                continue
            ok = set_profile(dev, p)
            s2 = wait_for_source(src["device_id"]) if ok else None
            entry = {"profile": p.get("name"), "description": p.get("description"), "switched": ok,
                     "node": s2 and s2["name"], "channels": s2 and s2["channels"], "positions": s2 and s2["positions"]}
            R["profile_survey"].append(entry)
            say(f"   · {p.get('description')}: " + (f"{entry['channels']} ch {','.join(entry['positions'])}" if s2 else "no input node"))
        if orig_profile:
            set_profile(dev, orig_profile)
            wait_for_source(src["device_id"])

    # ---- choose the profile to test
    if dev and enum:
        choices = [p for p in enum if profile_has_input(p) and p.get("available") != "no"]
        say("\n  Which profile should the tests run in? The bridge needs every input in one node.")
        for i, p in enumerate(choices, 1):
            mark = " (active)" if orig_profile and p.get("name") == orig_profile.get("name") else ""
            say(f"   {i}. {p.get('description')}  [{p.get('name')}]{mark}")
        default = next((i for i, p in enumerate(choices, 1) if orig_profile and p.get("name") == orig_profile.get("name")), 1)
        if src["channels"] < 4:
            default = next((i for i, p in enumerate(choices, 1) if p.get("name") == "pro-audio"), default)
        test_profile = choices[int(ask("Profile", str(default))) - 1]
        if not orig_profile or test_profile.get("name") != orig_profile.get("name"):
            set_profile(dev, test_profile)
        s2 = wait_for_source(src["device_id"])
        if s2:
            src = s2
        R["profile_tested"] = {k: test_profile.get(k) for k in ("index", "name", "description")}
        say(f"  Testing in {c('1', test_profile.get('description', '?'))}: {src['name']} · {src['channels']} ch {','.join(src['positions'])}")
    R["source_tested"] = {k: v for k, v in src.items() if k != "props"}
    nch = src["channels"]
    R["steps"] = {}

    def step(key: str, title: str, lines: list[str], seconds: float, save: bool = True) -> dict | None:
        h1(title)
        for ln in lines:
            say("  " + ln)
        if not wait_enter():
            R["steps"][key] = {"skipped": True}
            return None
        for k in (3, 2, 1):
            sys.stdout.write(f"\r  Recording in {k}… ")
            sys.stdout.flush()
            time.sleep(1)
        sys.stdout.write("\r  " + c("1;31", "● recording") + "      \n")
        rec = record(src, seconds)
        res = analyse(rec)
        if save and rec.raw:
            rec.save(out / f"{key}.wav")
        if rec.stderr.strip():
            res["pw_record_stderr"] = rec.stderr.strip()[-500:]
        R["steps"][key] = res
        show_step(res)
        return res

    def show_step(res: dict) -> None:
        say(f"  Received {res['seconds_received']} s of audio in {res['seconds_elapsed']} s · stream linked to the interface: {res['linked_to_target']}")
        say("  ch  pos     level   peak   reading p50/p95   zeros  ~Hz")
        for i, ch in enumerate(res["channels"]):
            if not ch.get("samples"):
                say(f"  {i + 1:>2}  no data")
                continue
            say(f"  {i + 1:>2}  {src['positions'][i]:<6} {fmt_db(ch['rms_db']):>6} {fmt_db(ch['peak_db']):>6}   {fmt_db(ch['frame_p50']):>6}/{fmt_db(ch['frame_p95']):<6}   {ch['zero_share']:>5.0%}  {ch['zc_hz'] or '':>5}")

    # ---- 2. gain
    h1("2 · Set the preamp gain (inputs 1 and 2)")
    say("  Plug an SM58 into input 1 (and a second one into input 2 if you have it). No phantom")
    say("  power needed. Hold it like a singer and sing your loudest chorus. Turn the GAIN knob")
    say("  until the interface's ring/LED is green and only flickers amber on the loudest notes.")
    say("  The meter below shows each channel (bar = level, number = peak dBFS). Aim for peaks")
    say("  around −12 to −6 dBFS. Press Enter when the gain is set.")
    if wait_enter("Press Enter to show the live meter, or s to skip"):
        record(src, 0, until_enter=True)
    R["gain_notes"] = ask("Where are the gain knobs now? (e.g. 'input 1 at 2 o'clock, input 2 at noon')", "")
    R["mic_count"] = ask("How many SM58s are plugged in (inputs 1–2)?", "1")
    R["other_inputs"] = ask("What is plugged into inputs 3 and 4 right now? (e.g. 'nothing')", "nothing")

    # ---- 3. baseline
    step("baseline", "3 · Silence", ["Everyone quiet, no music. This is each input's noise floor."], S(5))

    # ---- 4. one input at a time
    tone = out / "line-test-440L-660R.wav"
    write_stereo_test(tone)
    h1("4 · One input at a time")
    say("  Each recording feeds ONE input; the others should stay at their noise floor.")
    say(f"  For inputs 3 and 4 you need a line signal. Either play {tone.name} (left 440 Hz, right")
    say("  660 Hz, in the results folder) from a phone or laptop, or any tone-generator app, or let")
    say("  this PC play it through one of its outputs (cable from that output into input 3/4).")
    say(c("33", "  If you route a PC output back into the interface, turn Direct Monitor OFF first."))
    player = None
    if yes("Should this PC play the test signal for inputs 3 and 4?", False):
        sk = sinks()
        for i, s in enumerate(sk, 1):
            say(f"   {i}. {s['description']}  ·  {s['name']}")
        if sk:
            player = sk[int(ask("Play through which output?", "1")) - 1]
    R["line_source"] = f"PC output {player['description']}" if player else ask("What line source will you use for inputs 3 and 4?", "phone headphone output")

    def play_tone() -> subprocess.Popen | None:
        if not player:
            return None
        return subprocess.Popen(["pw-play", "--target", player["name"], str(tone)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for k in range(1, min(nch, 4) + 1):
        if k <= 2:
            lines = [f"Sing or talk into the mic on input {k}. Keep the other mic (if any) away from your mouth."]
        else:
            lines = [f"Plug the line source into input {k} only (unplug it from the other line input)",
                     "and start the test signal" + (" (this PC will play it)." if player else ".")]
        if k > as_int(R["mic_count"], 1) and k <= 2:
            lines = [f"No mic on input {k}? Skip with s, or plug the line source into it."]
        p = None
        h = None
        if k > 2 and player:
            h1(f"4.{k} · Input {k} only")
            for ln in lines:
                say("  " + ln)
            if not wait_enter():
                R["steps"][f"only_{k}"] = {"skipped": True}
                continue
            p = play_tone()
            time.sleep(0.8)
            rec = record(src, S(6))
            p.terminate()
            h = analyse(rec)
            rec.save(out / f"only_{k}.wav")
            R["steps"][f"only_{k}"] = h
            show_step(h)
        else:
            step(f"only_{k}", f"4.{k} · Input {k} only", lines, S(6))

    # ---- 5. loudness and bleed (input 1, plus input 2 if a second mic)
    h1("5 · Singing and bleed loudness")
    say("  Put the speakers at the volume you'd use for a karaoke night. Keep the gain as set in 2.")
    step("sing_dry", "5.1 · Singing, no music",
         ["Hold mic 1 like a singer and sing at your normal karaoke loudness, a verse or chorus,",
          "until the recording stops. Sing on mic 2 too if it's plugged in (take turns)."], S(12))
    step("bleed_song", "5.2 · Bleed from a Song",
         ["Start a song with vocals through the speakers at party volume.",
          "Hold mic 1 (and mic 2) where a singer would, pointing the way a singer would, but DON'T sing.",
          "Leave the song playing for 5.3."], S(15))
    step("sing_song", "5.3 · Singing over the Song",
         ["With the song still playing, sing along on mic 1 at your normal loudness."], S(15))
    R["song_played"] = ask("Which song and player did you use, and roughly what volume?", "")

    tones_path = out / "calibration-tones.wav"
    marks = write_tones(tones_path)
    h1("5.4 · Calibration tones (like \"Calibrate this mic now\")")
    say("  Stop the song. This PC plays 8 short tones through the speakers at the same system")
    say("  volume, as the Stage's calibration would. Hold mic 1 (and 2) like in 5.2. Don't sing.")
    sk = sinks()
    R["steps"]["tones"] = {"skipped": True}
    if sk and wait_enter():
        default_sink = run(["pactl", "get-default-sink"]).strip()
        for i, s in enumerate(sk, 1):
            say(f"   {i}. {s['description']}  ·  {s['name']}" + ("  (default)" if s["name"] == default_sink else ""))
        dflt = next((i for i, s in enumerate(sk, 1) if s["name"] == default_sink), 1)
        spk = sk[int(ask("Which output are the speakers on?", str(dflt))) - 1]

        def play_later():
            time.sleep(0.5)
            subprocess.run(["pw-play", "--target", spk["name"], str(tones_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        th = threading.Thread(target=play_later)
        th.start()
        rec = record(src, 7.5)
        th.join()
        rec.save(out / "tones.wav")
        result = analyse(rec)
        result["speaker_output"] = spk["description"]
        result["tone_rms_dbfs_in_file"] = -18.0
        R["steps"]["tones"] = result
        show_step(result)

    # ---- 6. endurance: everything at once
    step("endurance", "6 · All inputs at once, 60 s",
         ["Everything connected: mic(s) on 1–2 and the line source on 3 (and 4, with a Y-cable or",
          "a second source). Start the line signal, then keep talking or humming into the mic(s)",
          "now and then. This checks that no channel drops out while all run in one stream."], S(60), save=False)

    # ---- 7. browser path
    h1("7 · The browser path (Chromium, processing off, 2 channels)")
    say("  The Stage browser can read 2 channels of a device. This checks that it gets inputs 1")
    say("  and 2 as separate channels, and whether inputs 3–4 leak into them.")
    if wait_enter("Press Enter to open the browser check, or s to skip"):
        phases = [
            {"key": "quiet", "text": "stay quiet", "seconds": 4},
            {"key": "in1", "text": "sing into the mic on input 1", "seconds": 6},
            {"key": "in2", "text": "sing into the mic on input 2 (or skip: stay quiet)", "seconds": 6},
            {"key": "in3", "text": "line signal into input 3 only (mics quiet)", "seconds": 6},
            {"key": "in4", "text": "line signal into input 4 only (mics quiet)", "seconds": 6},
        ]
        if args.short:
            for ph in phases:
                ph["seconds"] = 2
        p = None
        if player and yes("Should this PC play the test signal during the browser check (for inputs 3 and 4)?", True):
            p = subprocess.Popen(["pw-play", "--target", player["name"], str(tone)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        R["browser"] = browser_check(phases)
        if p:
            p.terminate()
        if R["browser"]:
            b = R["browser"]
            say(f"  settings: {json.dumps(b.get('settings'))}")
            for ph in b.get("phases", []):
                say(f"  {ph['key']:>5}: ch1 {fmt_db(ph['ch'][0]['p50'])} dB · ch2 {fmt_db(ph['ch'][1]['p50'])} dB")
        else:
            say(c("33", "  No browser results arrived."))
    R["browser_profile"] = R.get("profile_tested")

    # ---- restore
    if dev and orig_profile and R.get("profile_tested", {}).get("name") != orig_profile.get("name"):
        if yes(f"Switch the interface back to its original profile ({orig_profile.get('description')})?", True):
            set_profile(dev, orig_profile)

    R["notes"] = ask("Anything odd you noticed (clicks, dropouts, LEDs)? Enter to skip", "")
    (out / "results.json").write_text(json.dumps(strip_frames(R), indent=2))
    report = make_report(R, src)
    (out / "report.md").write_text(report)
    h1("Done")
    say(report)
    say(c("1;32", f"\nSaved: {out / 'report.md'}  (send this back)  and {out / 'results.json'}"))
    return 0


# ----------------------------------------------------------------------------- report


def verdicts(R: dict, nch: int) -> list[str]:
    v = []
    steps = R["steps"]
    base = steps.get("baseline") or {}
    floor = [ch.get("rms_db") for ch in base.get("channels", [])] if base.get("channels") else [None] * nch
    for k in range(1, min(nch, 4) + 1):
        s = steps.get(f"only_{k}") or {}
        if not s.get("channels"):
            v.append(f"- Input {k} alone: not recorded.")
            continue
        chs = s["channels"]
        lv = [ch.get("frame_p95") if ch.get("frame_p95") is not None else FLOOR_DB for ch in chs]
        fed = lv[k - 1]
        others = [(i + 1, x) for i, x in enumerate(lv) if i != k - 1 and i < 4]
        worst = max(others, key=lambda t: t[1]) if others else (None, FLOOR_DB)
        sep = fed - worst[1]
        loudest = max(range(len(lv)), key=lambda i: lv[i]) + 1
        if loudest != k and lv[loudest - 1] > fed + 3:
            tag = f"**WRONG CHANNEL**: loudest on ch {loudest}"
        elif fed < (floor[k - 1] or FLOOR_DB) + 15:
            tag = "**NO SIGNAL** on its channel"
        elif sep >= 30:
            tag = "clean and separate"
        elif sep >= 15:
            tag = "separate, some bleed (acoustic between mics?)"
        else:
            tag = "**MIXED** with another channel"
        v.append(f"- Input {k} alone: {tag}. Ch {k} at {fmt_db(fed)} dBFS (p95 reading), loudest other ch {worst[0]} at {fmt_db(worst[1])} → {sep:.0f} dB apart.")
    e = steps.get("endurance") or {}
    if e.get("channels"):
        rcv, ela = e["seconds_received"], e["seconds_elapsed"]
        gaps = [f"ch {i + 1}: {ch['longest_zero_run_s']} s" for i, ch in enumerate(e["channels"]) if ch.get("longest_zero_run_s", 0) > 0.2]
        v.append(f"- 60 s with everything on: received {rcv} s in {ela} s; exact-silence runs over 0.2 s: {', '.join(gaps) or 'none'}.")
    return v


def loudness_section(R: dict, nch: int) -> list[str]:
    steps = R["steps"]
    out = []
    mics = [0] + ([1] if as_int(R.get("mic_count"), 1) >= 2 and nch > 1 else [])
    for m in mics:
        sd, bs, ss, tn = (steps.get(k) or {} for k in ("sing_dry", "bleed_song", "sing_song", "tones"))
        def frames(s):
            chs = s.get("channels") or []
            return chs[m].get("_frames", []) if len(chs) > m else []
        bleed = frames(bs)
        tones = frames(tn)
        base = frames(steps.get("baseline") or {})
        floor = pct(base, 50) if base else None
        dry = frames(sd)
        over = frames(ss)
        # singing readings: frames clearly above the noise floor (dry) or above song bleed p95 (over song)
        thr_dry = (floor if floor is not None else -90) + 20
        dry_v = [x for x in dry if x > thr_dry]
        out.append(f"\n**Mic on input {m + 1}** (readings = RMS over {WIN} samples, hop {HOP})\n")
        out.append("| What | p05 | p50 | p95 | max |")
        out.append("|---|---|---|---|---|")
        for name, fr in (("Noise floor (silence)", base), ("Singing, no music (voiced readings)", dry_v), ("Song bleed, nobody singing", bleed),
                         ("Singing over the Song (all readings)", over), ("Calibration tones (whole recording)", tones)):
            out.append(f"| {name} | {fmt_db(pct(fr, 5))} | {fmt_db(pct(fr, 50))} | {fmt_db(pct(fr, 95))} | {fmt_db(max(fr) if fr else None)} |")
        out.append("")
        gates = [("Fallback gate", FALLBACK_GATE)]
        if bleed:
            gates.append(("Song bleed p95 + 6 dB", pct(bleed, 95) + GATE_MARGIN))
        if tones:
            # tones are 8×400 ms in 7.5 s: take the loud readings as the tone level
            tone_lv = pct(tones, 95)
            gates.append(("Tone bleed p95 + 6 dB (what \"Calibrate this mic now\" would set)", tone_lv + GATE_MARGIN))
        out.append("| Gate | dBFS | singing (no music) readings passing | singing over Song readings passing | Song bleed readings passing |")
        out.append("|---|---|---|---|---|")
        for name, g in gates:
            def share(fr):
                return f"{sum(1 for x in fr if x >= g) / len(fr):.0%}" if fr else "–"
            out.append(f"| {name} | {g:.1f} | {share(dry_v)} | {share(over)} | {share(bleed)} |")
    return out


def make_report(R: dict, src: dict) -> str:
    nch = src["channels"]
    s = R["system"]
    L = ["# Four inputs through the mic bridge: results", "",
         f"Ticket: {R['ticket']} · script v{R['script_version']} · {s.get('date')}", "",
         "## System", "",
         f"- OS {s.get('os')} · kernel {s.get('kernel')} · {s.get('pipewire')} · WirePlumber {s.get('wireplumber')} · Pulse server: {s.get('pulse_server')}",
         f"- Graph: rate {s.get('clock.rate')} · quantum {s.get('clock.quantum')} ({s.get('clock.min-quantum')}–{s.get('clock.max-quantum')}) · Chromium: {s.get('chromium')}",
         f"- Device: {json.dumps(R.get('device', {}).get('device.description'))} · product {R.get('device', {}).get('device.product.name')} · USB {R.get('device', {}).get('device.vendor.id')}:{R.get('device', {}).get('device.product.id')}",
         "", "## Profile and channels", ""]
    pi = R.get("profile_initial") or {}
    L.append(f"- Active profile at start: **{pi.get('description')}** `{pi.get('name')}`")
    si = R["source_initial"]
    L.append(f"- Its input node: `{si['name']}` · {si['channels']} ch · `{','.join(si['positions'])}`")
    for e in R.get("profile_survey", []):
        L.append(f"  - profile {e['description']} `{e['profile']}`: " + (f"{e['channels']} ch `{','.join(e['positions'])}` node `{e['node']}`" if e.get("channels") else "no input node"))
    pt = R.get("profile_tested") or {}
    L.append(f"- Tested in: **{pt.get('description')}** `{pt.get('name')}` → `{src['name']}` · {nch} ch · `{','.join(src['positions'])}`")
    if R.get("alsa", {}).get("stream0"):
        cap = R["alsa"]["stream0"]
        m = cap.find("Capture:")
        if m >= 0:
            L += ["", "ALSA capture endpoint (`/proc/asound/cardN/stream0`):", "", "```", cap[m:m + 700].strip(), "```"]
    L += ["", "## Setup", "",
          f"- Mics: {R.get('mic_count')} SM58 · gain: {R.get('gain_notes') or '–'} · inputs 3–4 during setup: {R.get('other_inputs')}",
          f"- Line source: {R.get('line_source')} · Song: {R.get('song_played') or '–'}",
          "", "## Verdicts", ""]
    L += verdicts(R, nch)
    L += ["", "## Per-step levels (dBFS)", "",
          "Per channel: RMS level / p95 reading. `silent` = exact digital zero.", ""]
    hdr = "| Step | rec s | linked | " + " | ".join(f"ch{i + 1} {src['positions'][i]}" for i in range(nch)) + " |"
    L += [hdr, "|" + "---|" * (nch + 3)]
    for key, st in R["steps"].items():
        if st.get("skipped"):
            L.append(f"| {key} | skipped |" + " |" * (nch + 1))
            continue
        cells = []
        for ch in st["channels"]:
            cells.append(f"{fmt_db(ch.get('rms_db'))} / {fmt_db(ch.get('frame_p95'))}" + (f" ~{int(ch['zc_hz'])}Hz" if key.startswith("only_") and ch.get("zc_hz") else ""))
        L.append(f"| {key} | {st['seconds_received']}/{st['seconds_elapsed']} | {st['linked_to_target']} | " + " | ".join(cells) + " |")
    clipped = [f"{k} ch{i + 1}" for k, st in R["steps"].items() if st.get("channels") for i, ch in enumerate(st["channels"]) if ch.get("clipped_samples")]
    if clipped:
        L.append(f"\nClipping in: {', '.join(clipped)}")
    errs = {k: st["pw_record_stderr"] for k, st in R["steps"].items() if st.get("pw_record_stderr")}
    if errs:
        L += ["", "pw-record messages:", "", "```"] + [f"{k}: {v}" for k, v in errs.items()] + ["```"]
    L += ["", "## Loudness gate check"]
    L += loudness_section(R, nch)
    L += ["", "## Browser path", ""]
    b = R.get("browser")
    if not b:
        L.append("Not run.")
    else:
        L.append(f"- {b.get('userAgent')}")
        L.append(f"- Device `{b.get('label')}` · error: {b.get('error')}")
        L.append(f"- settings: `{json.dumps(b.get('settings'))}`")
        L.append(f"- capabilities channelCount: `{json.dumps((b.get('capabilities') or {}).get('channelCount'))}` · source node channels {b.get('sourceChannelCount')} · context {b.get('contextSampleRate')} Hz · track at end {b.get('trackStateAtEnd')}")
        L += ["", "| Phase | ch1 p50 / p95 | ch2 p50 / p95 |", "|---|---|---|"]
        for ph in b.get("phases", []):
            a, z = ph["ch"]
            L.append(f"| {ph['text']} | {fmt_db(a['p50'])} / {fmt_db(a['p95'])} | {fmt_db(z['p50'])} / {fmt_db(z['p95'])} |")
    if R.get("notes"):
        L += ["", "## Notes from the run", "", R["notes"]]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)
