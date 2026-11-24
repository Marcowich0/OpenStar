// Playwright measurement: what do Chromium / Firefox on Linux deliver from a 4-channel
// PipeWire source, and do PipeWire remap sources work as a per-mic workaround?
// Run inside the container (see README.md). Results: stdout + /work/out/results.json.
import { chromium, firefox } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pactl = (...a) => execFileSync('pactl', a, { encoding: 'utf8' }).trim();
const log = (...a) => console.error('[measure]', ...a);

// ---- tiny localhost server (secure context for getUserMedia) ----
const html = readFileSync(new URL('./page.html', import.meta.url));
const server = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(8123, '127.0.0.1', r));
const URL_ = 'http://localhost:8123/';

// ---- PipeWire helpers ----
function sourceOutputs() {
  const sources = Object.fromEntries(JSON.parse(pactl('-f', 'json', 'list', 'sources')).map((s) => [s.index, s.name]));
  return JSON.parse(pactl('-f', 'json', 'list', 'source-outputs')).map((o) => ({
    source: sources[o.source] ?? o.source,
    spec: o.sample_specification,
    map: o.channel_map,
    app: o.properties['application.name'],
  }));
}
const loadRemap = (name, desc, masterMap, map) =>
  pactl('load-module', 'module-remap-source', 'master=mic4_aux', `source_name=${name}`,
    `master_channel_map=${masterMap}`, `channel_map=${map}`, `source_properties=device.description=${desc}`);
const unload = (idx) => pactl('unload-module', String(idx));

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const VARIANTS = [
  { name: 'raw, channelCount ideal 4', audio: { ...RAW, channelCount: { ideal: 4 } } },
  { name: 'raw, channelCount exact 4', audio: { ...RAW, channelCount: { exact: 4 } } },
  { name: 'raw, no channelCount', audio: { ...RAW } },
  { name: 'defaults (processing on)', audio: {} },
  { name: 'defaults + channelCount ideal 4', audio: { channelCount: { ideal: 4 } } },
  { name: 'raw, ideal 4, AudioContext 44100', audio: { ...RAW, channelCount: { ideal: 4 } }, opts: { sampleRate: 44100 } },
];

const summarize = (p) => p.channels.filter((c) => c.ch <= 6).map((c) => `${c.ch}:${c.tones.join('+') || '-'}`).join(' ');

async function freshPage(ctx) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('console', m.text()); });
  await page.goto(URL_);
  await page.evaluate(() => unlockLabels());
  return page;
}

async function run(name, launch, { full = true } = {}) {
  log(`==== ${name}`);
  const R = { browser: name };
  let ctx = await launch();
  R.version = ctx.browser()?.version() ?? null;
  let page = await freshPage(ctx);
  R.userAgent = await page.evaluate(() => navigator.userAgent);
  R.devices = await page.evaluate(() => listDevices());
  log('devices', R.devices.map((d) => `${d.label} [InputDeviceInfo caps channelCount ${JSON.stringify(d.capChannelCount)}]`).join(' | '));

  // ---- Steps 1-3 + 6: the 4-channel sources ----
  R.fourChannel = [];
  for (const src of ['Virtual-4ch-mic4_aux', 'Virtual-4ch-mic4_quad', 'Virtual-4ch-aiff']) {
    for (const v of full && !src.endsWith('aiff') ? VARIANTS : VARIANTS.slice(0, 1)) {
      const o = await page.evaluate(([s, a, opts]) => openMic(s, a, opts), [src, v.audio, v.opts ?? {}]);
      const row = { source: src, variant: v.name, ...o };
      if (!o.error) {
        await sleep(1500);
        row.probe = await page.evaluate((id) => probe(id), o.id);
        row.pulseStreams = sourceOutputs();
        row.summary = summarize(row.probe);
        await page.evaluate((id) => closeMic(id), o.id);
        await sleep(300);
      }
      log(src, '|', v.name, '|', o.error ?? `settings.channelCount=${o.settings.channelCount} caps=${JSON.stringify(o.caps)} srcCh=${row.probe.srcChannels} ${row.summary} pulse=${JSON.stringify(row.pulseStreams.map((s) => `${s.source}:${s.spec}:${s.map}`))}`);
      R.fourChannel.push(row);
    }
  }
  if (!full) { await ctx.close(); return R; }

  // ---- Step 4: remap sources, opened concurrently ----
  const mods = {};
  for (let i = 0; i < 4; i++) mods[`mic_ch${i + 1}`] = loadRemap(`mic_ch${i + 1}`, `Remap-ch${i + 1}`, `aux${i}`, 'mono');
  mods.mic_st12 = loadRemap('mic_st12', 'Remap-st12', 'aux0,aux1', 'front-left,front-right');
  mods.mic_st34 = loadRemap('mic_st34', 'Remap-st34', 'aux2,aux3', 'front-left,front-right');
  await sleep(1000);
  R.remapDevices = (await page.evaluate(() => listDevices())).filter((d) => d.label.startsWith('Remap'));

  const concurrent = async (labels, audio, holdMs) => {
    const opened = [];
    for (const l of labels) opened.push(await page.evaluate(([s, a]) => openMic(s, a), [l, audio]));
    const errs = opened.filter((o) => o.error);
    if (errs.length) { await page.evaluate(() => closeAll()); return { errors: errs.map((e) => e.error) }; }
    await sleep(1500);
    const t0 = await Promise.all(opened.map((o) => page.evaluate((id) => probe(id), o.id)));
    const pulse = sourceOutputs();
    await sleep(holdMs);
    const t1 = await Promise.all(opened.map((o) => page.evaluate((id) => probe(id), o.id)));
    await page.evaluate(() => closeAll());
    await sleep(300);
    return {
      settings: opened.map((o) => ({ label: o.label, channelCount: o.settings.channelCount, sampleRate: o.settings.sampleRate })),
      pulseStreams: pulse,
      start: t0.map((p) => ({ label: p.label, readyState: p.readyState, muted: p.muted, srcCh: p.srcChannels, summary: summarize(p), rms1: p.channels[0].rmsDb })),
      [`after${holdMs / 1000}s`]: t1.map((p) => ({ label: p.label, readyState: p.readyState, muted: p.muted, events: p.events, srcCh: p.srcChannels, summary: summarize(p), rms1: p.channels[0].rmsDb })),
    };
  };
  const brief = (r) => JSON.stringify(r.errors ?? Object.entries(r).filter(([k]) => k.startsWith('after')).map(([, v]) => v.map((p) => `${p.label}=${p.readyState}${p.muted ? '/muted' : ''}:${p.summary.split(' ')[0]}(rms ${p.rms1})`))[0]);
  const monoLabels = ['Remap-ch1', 'Remap-ch2', 'Remap-ch3', 'Remap-ch4'];
  R.indep4raw = await concurrent(['Indep-ch1', 'Indep-ch2', 'Indep-ch3', 'Indep-ch4'], RAW, 5000);
  log('control: 4 independent mono sources, raw', brief(R.indep4raw));
  R.mono4raw = await concurrent(monoLabels, RAW, 20000);
  log('4 mono remaps raw', brief(R.mono4raw));
  R.mono4rawRepeats = [];
  for (let i = 0; i < 3; i++) {
    R.mono4rawRepeats.push(await concurrent(monoLabels, RAW, 3000));
    log(`4 mono remaps raw, repeat ${i + 1}`, brief(R.mono4rawRepeats[i]));
  }
  R.mono4defaults = await concurrent(monoLabels, {}, 5000);
  log('4 mono remaps defaults', brief(R.mono4defaults));
  R.stereo2raw = await concurrent(['Remap-st12', 'Remap-st34'], { ...RAW, channelCount: { ideal: 2 } }, 20000);
  log('2 stereo remaps raw', brief(R.stereo2raw));

  // ---- Step 5: deviceId stability ----
  const S = (R.deviceIdStability = {});
  const find = async (p, l) => p.evaluate((x) => findDevice(x), l);
  S.original = await find(page, 'Remap-ch1');
  // keep a track open on ch1 while its module is unloaded (hot-unplug behaviour)
  const live = await page.evaluate(() => openMic('Remap-ch1', { echoCancellation: false, noiseSuppression: false, autoGainControl: false }));
  await sleep(1000);
  unload(mods.mic_ch1);
  await sleep(1500);
  S.openTrackAfterUnload = await page.evaluate((id) => { const p = probe(id); return { readyState: p.readyState, muted: p.muted, events: p.events }; }, live.id);
  S.listedAfterUnload = !!(await find(page, 'Remap-ch1'));
  mods.mic_ch1 = loadRemap('mic_ch1', 'Remap-ch1', 'aux0', 'mono');
  await sleep(1500);
  S.openTrackAfterReload = await page.evaluate((id) => { const p = probe(id); return { readyState: p.readyState, muted: p.muted, events: p.events, summary: p.channels[0].tones }; }, live.id);
  await page.evaluate(() => closeAll());
  await page.close();
  page = await freshPage(ctx);
  S.reloadedSameName = await find(page, 'Remap-ch1');
  unload(mods.mic_ch1);
  mods.mic_ch1 = loadRemap('mic_ch1_renamed', 'Remap-ch1', 'aux0', 'mono');
  await sleep(1500);
  await page.close();
  page = await freshPage(ctx);
  S.reloadedDifferentNameSameDescription = await find(page, 'Remap-ch1');
  unload(mods.mic_ch1);
  mods.mic_ch1 = loadRemap('mic_ch1', 'Remap-ch1', 'aux0', 'mono');
  await sleep(1500);
  await ctx.close();
  ctx = await launch();
  page = await freshPage(ctx);
  S.afterBrowserRestartSameProfile = await find(page, 'Remap-ch1');
  const id = (d) => d?.deviceId ?? null;
  S.verdict = {
    sameNameKeepsId: id(S.reloadedSameName) === id(S.original),
    differentNameKeepsId: id(S.reloadedDifferentNameSameDescription) === id(S.original),
    restartKeepsId: id(S.afterBrowserRestartSameProfile) === id(S.original),
    labelsStable: [S.reloadedSameName, S.reloadedDifferentNameSameDescription, S.afterBrowserRestartSameProfile].every((d) => d?.label === S.original?.label),
  };
  log('deviceId stability', JSON.stringify(S));

  await ctx.close();
  for (const m of Object.values(mods)) unload(m);
  return R;
}

const profile = (n) => { const d = `/tmp/profile-${n}`; rmSync(d, { recursive: true, force: true }); return d; };
const chromeDir = profile('chromium');
const chromeHeadlessDir = profile('chromium-headless-shell');
const ffDir = profile('firefox');

const chromiumArgs = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const results = { pulseNoChannelmix: process.env.PW_PULSE_NO_CHANNELMIX === '1', forceQuantum: process.env.FORCE_QUANTUM ?? null, pipewire: execFileSync('pipewire', ['--version'], { encoding: 'utf8' }).trim(), runs: [] };
const which = (process.env.BROWSERS ?? 'chromium,chromium-headless-shell,firefox').split(',');

if (which.includes('chromium'))
  results.runs.push(await run('chromium (headed, Xvfb)', () =>
    chromium.launchPersistentContext(chromeDir, { headless: false, args: chromiumArgs, permissions: ['microphone'] })));
if (which.includes('chromium-headless-shell'))
  results.runs.push(await run('chromium headless shell', () =>
    chromium.launchPersistentContext(chromeHeadlessDir, { headless: true, args: chromiumArgs, permissions: ['microphone'] }), { full: false }));
if (which.includes('firefox'))
  results.runs.push(await run('firefox (headed, Xvfb)', () =>
    firefox.launchPersistentContext(ffDir, {
      headless: false,
      firefoxUserPrefs: {
        'media.navigator.permission.disabled': true,
        'media.navigator.streams.fake': false,
        'media.autoplay.default': 0,
        'permissions.default.microphone': 1,
      },
    })));

mkdirSync('/work/out', { recursive: true });
const outFile = `/work/out/${process.env.RESULTS_NAME ?? 'results'}.json`;
writeFileSync(outFile, JSON.stringify(results, null, 2));
log('wrote', outFile);
server.close();
