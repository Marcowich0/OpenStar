// PROTOTYPE (throwaway): pure timing model for the Timing editor prototype.
// No DOM. The page calls into this; nothing flows back. This is the part worth
// lifting into the real code once the interaction is settled.
//
// Covers unversioned and 1.x files only (GAP in ms, beat = 60 / (BPM * 4) s).
const Timing = (() => {
  const NOTE_RE = /^([:*FRG])(\s+)(-?\d+)(\s+)(\d+)(\s+)(-?\d+)(.*)$/;
  const BREAK_RE = /^-(\s*)(-?\d+)(.*)$/;

  function parse(text) {
    const raw = text.split('\n'); // each entry keeps its own '\r' if it had one
    const headers = {};
    const notes = [];
    const breaks = [];
    let line = 0;
    let voice = 1;
    let lineHasNotes = false;
    raw.forEach((r, idx) => {
      const s = r.replace(/\r$/, '');
      if (s.startsWith('#')) {
        const m = /^#([^:]+):(.*)$/.exec(s);
        if (m) headers[m[1].trim().toUpperCase()] = { idx, key: m[1], value: m[2].trim() };
        return;
      }
      let m = NOTE_RE.exec(s);
      if (m) {
        notes.push({ idx, type: m[1], beat: +m[3], len: +m[5], pitch: +m[7], lyric: m[8].replace(/^\s/, ''), line, voice });
        lineHasNotes = true;
        return;
      }
      m = BREAK_RE.exec(s);
      if (m) { breaks.push({ idx, beat: +m[2], afterLine: line }); line++; lineHasNotes = false; return; }
      m = /^P\s*(\d+)/.exec(s);
      if (m) { voice = +m[1]; if (lineHasNotes) line++; lineHasNotes = false; }
    });
    const num = (h) => (h ? parseFloat(h.value.replace(',', '.')) : NaN);
    const version = headers.VERSION ? headers.VERSION.value : null;
    if (version && /^2\./.test(version)) throw new Error('2.0.0 files are not handled by this prototype');
    if (headers.RELATIVE && /yes/i.test(headers.RELATIVE.value)) throw new Error('Relative files are not handled by this prototype');
    const lines = [];
    notes.forEach((n, i) => {
      let l = lines.find((x) => x.id === n.line);
      if (!l) { l = { id: n.line, voice: n.voice, notes: [] }; lines.push(l); }
      l.notes.push(i);
    });
    lines.sort((a, b) => a.id - b.id);
    const lineIndexOfId = new Map(lines.map((l, k) => [l.id, k]));
    notes.forEach((n) => (n.k = lineIndexOfId.get(n.line)));
    breaks.forEach((b) => (b.k = lineIndexOfId.has(b.afterLine) ? lineIndexOfId.get(b.afterLine) : -1));
    return {
      raw, headers, notes, breaks, lines, version,
      gap: isNaN(num(headers.GAP)) ? 0 : num(headers.GAP),
      bpm: num(headers.BPM),
      videoGap: isNaN(num(headers.VIDEOGAP)) ? 0 : num(headers.VIDEOGAP),
      audioFile: (headers.AUDIO || headers.MP3 || {}).value,
      videoFile: (headers.VIDEO || {}).value,
    };
  }

  // Editable state: just the numbers a Timing edit may change.
  function initialState(song) {
    return {
      gap: song.gap, bpm: song.bpm, videoGap: song.videoGap,
      beat: song.notes.map((n) => n.beat), len: song.notes.map((n) => n.len),
      brk: song.breaks.map((b) => b.beat),
    };
  }

  const spb = (st) => 60 / (st.bpm * 4);
  const timeOfBeat = (st, beat) => st.gap / 1000 + beat * spb(st);
  const beatOfTime = (st, t) => (t - st.gap / 1000) / spb(st);
  const noteStart = (st, i) => timeOfBeat(st, st.beat[i]);
  const noteEnd = (st, i) => timeOfBeat(st, st.beat[i] + st.len[i]);
  const lineStart = (song, st, k) => noteStart(st, song.lines[k].notes[0]);
  const lineEnd = (song, st, k) => { const ns = song.lines[k].notes; return noteEnd(st, ns[ns.length - 1]); };

  // Keep every line break between the end of its line and the start of the next one.
  function fixBreaks(song, st) {
    const brk = st.brk.slice();
    song.breaks.forEach((b, j) => {
      if (b.k < 0 || b.k + 1 >= song.lines.length) return;
      const prev = song.lines[b.k].notes, next = song.lines[b.k + 1].notes;
      const lo = st.beat[prev[prev.length - 1]] + st.len[prev[prev.length - 1]];
      const hi = st.beat[next[0]];
      if (brk[j] < lo || brk[j] > hi) brk[j] = Math.max(Math.min(brk[j], hi), Math.min(lo, hi));
    });
    return { ...st, brk };
  }

  // Edits. Each is a plain object; the state is the initial state with every edit applied.
  function apply(song, st, op) {
    switch (op.type) {
      case 'gap': return { ...st, gap: op.gap };
      case 'bpm': return { ...st, bpm: op.bpm };
      case 'gapBpm': return { ...st, gap: op.gap, bpm: op.bpm };
      case 'videoGap': return { ...st, videoGap: op.videoGap };
      case 'shiftLines': {
        const beat = st.beat.slice(), brk = st.brk.slice();
        song.notes.forEach((n, i) => { if (n.k >= op.from && n.k <= op.to) beat[i] += op.beats; });
        song.breaks.forEach((b, j) => { if (b.k >= op.from && b.k < op.to) brk[j] += op.beats; });
        return fixBreaks(song, { ...st, beat, brk });
      }
      case 'stretchLines': {
        const beat = st.beat.slice(), len = st.len.slice(), brk = st.brk.slice();
        const anchor = st.beat[song.lines[op.from].notes[0]];
        const map = (b) => anchor + Math.round((b - anchor) * op.factor);
        song.notes.forEach((n, i) => {
          if (n.k < op.from || n.k > op.to) return;
          const s = map(st.beat[i]), e = map(st.beat[i] + st.len[i]);
          beat[i] = s; len[i] = Math.max(1, e - s);
        });
        song.breaks.forEach((b, j) => { if (b.k >= op.from && b.k < op.to) brk[j] = map(st.brk[j]); });
        return fixBreaks(song, { ...st, beat, len, brk });
      }
      case 'shiftNote': {
        const beat = st.beat.slice(); beat[op.i] += op.beats;
        return fixBreaks(song, { ...st, beat });
      }
      case 'resizeNote': {
        const len = st.len.slice(); len[op.i] = Math.max(1, op.len);
        return fixBreaks(song, { ...st, len });
      }
      default: throw new Error('unknown edit ' + op.type);
    }
  }

  const replay = (song, ops) => ops.reduce((st, op) => apply(song, st, op), initialState(song));

  // Solve GAP and BPM so that two beats land at two given times (pin + drag, or two tap anchors).
  function solveTwoPoints(b1, t1, b2, t2) {
    const s = (t2 - t1) / (b2 - b1);
    return { gap: Math.round((t1 - b1 * s) * 1000), bpm: round2(60 / (s * 4)) };
  }

  // Least-squares line through (beat, time) pairs -> GAP and BPM.
  function fitLine(pairs) {
    const n = pairs.length;
    const mb = pairs.reduce((a, p) => a + p.beat, 0) / n, mt = pairs.reduce((a, p) => a + p.time, 0) / n;
    let sxy = 0, sxx = 0;
    pairs.forEach((p) => { sxy += (p.beat - mb) * (p.time - mt); sxx += (p.beat - mb) ** 2; });
    const s = sxy / sxx;
    return { gap: Math.round((mt - mb * s) * 1000), bpm: round2(60 / (s * 4)) };
  }

  const round2 = (x) => Math.round(x * 100) / 100;

  // ---- Matching notes against the pitch heard in the audio ----
  // pitch: Float32Array of detected frequency per frame (0 = unvoiced), frames every `hop` seconds.
  function buildMatcher(pitch, hop) {
    const N = pitch.length;
    const pc = new Float32Array(N);
    for (let i = 0; i < N; i++) pc[i] = pitch[i] > 0 ? (((12 * Math.log2(pitch[i] / 440) + 69) % 12) + 12) % 12 : -1;
    const prefix = [];
    for (let p = 0; p < 12; p++) {
      const a = new Int32Array(N + 1);
      for (let i = 0; i < N; i++) {
        let hit = 0;
        if (pc[i] >= 0) { const d = Math.abs(((pc[i] - p + 18) % 12) - 6); hit = d <= 1 ? 1 : 0; }
        a[i + 1] = a[i] + hit;
      }
      prefix.push(a);
    }
    const scorable = (n) => n.type === ':' || n.type === '*';
    // hits and frames for one note placed at [t0, t1)
    function noteHits(p, t0, t1) {
      const i0 = Math.max(0, Math.min(N, Math.round(t0 / hop))), i1 = Math.max(0, Math.min(N, Math.round(t1 / hop)));
      return [prefix[((p % 12) + 12) % 12][i1] - prefix[((p % 12) + 12) % 12][i0], Math.max(1, i1 - i0)];
    }
    // fraction of each note's frames where the heard pitch class is within a semitone
    function fitOf(song, idxs, place) {
      let h = 0, f = 0;
      for (const i of idxs) {
        const n = song.notes[i]; if (!scorable(n)) continue;
        const [t0, t1] = place(i);
        const [a, b] = noteHits(n.pitch, t0, t1); h += a; f += b;
      }
      return f ? h / f : 0;
    }
    const allIdx = (song) => song.notes.map((_, i) => i);
    const placeWith = (st, g, s) => (i) => [g + st.beat[i] * s, g + (st.beat[i] + st.len[i]) * s];

    function noteFit(song, st, i) {
      const n = song.notes[i]; if (!scorable(n)) return null;
      const [a, b] = noteHits(n.pitch, noteStart(st, i), noteEnd(st, i)); return a / b;
    }
    const lineFit = (song, st, k) => fitOf(song, song.lines[k].notes, placeWith(st, st.gap / 1000, spb(st)));
    const songFit = (song, st) => fitOf(song, allIdx(song), placeWith(st, st.gap / 1000, spb(st)));

    // Search GAP (and optionally tempo) that best matches the singing.
    function autoFit(song, st, { tempo = true } = {}) {
      const idx = allIdx(song);
      const s0 = spb(st), g0 = st.gap / 1000;
      const pivotBeat = st.beat[idx[Math.floor(idx.length / 2)]];
      const pivotT0 = g0 + pivotBeat * s0;
      const evalAt = (off, scale) => {
        const s = s0 * scale, g = pivotT0 + off - pivotBeat * s;
        return fitOf(song, idx, placeWith(st, g, s));
      };
      let best = { off: 0, scale: 1, fit: evalAt(0, 1) };
      const scan = (offs, scales) => { for (const sc of scales) for (const o of offs) { const v = evalAt(o, sc); if (v > best.fit) best = { off: o, scale: sc, fit: v }; } };
      const range = (c, w, step) => { const a = []; for (let x = c - w; x <= c + w + 1e-9; x += step) a.push(x); return a; };
      scan(range(0, 10, 0.04), tempo ? range(1, 0.03, 0.0005) : [1]);
      scan(range(best.off, 0.06, 0.002), tempo ? range(best.scale, 0.0006, 0.00005) : [1]);
      const s = s0 * best.scale, g = pivotT0 + best.off - pivotBeat * s;
      return { gap: Math.round(g * 1000), bpm: tempo ? round2(60 / (s * 4)) : st.bpm, fit: best.fit };
    }

    // Lines that still sit off the singing after a global fix, with a suggested whole-beat shift.
    function lineSuggestions(song, st) {
      const out = [];
      song.lines.forEach((l, k) => {
        const now = lineFit(song, st, k);
        let best = { off: 0, fit: now };
        for (let o = -1.5; o <= 1.5; o += 0.01) {
          const f = fitOf(song, l.notes, placeWith(st, st.gap / 1000 + o, spb(st)));
          if (f > best.fit + 1e-9) best = { off: o, fit: f };
        }
        const beats = Math.round(best.off / spb(st));
        if (beats !== 0 && best.fit - now >= 0.2 && best.fit >= 0.5) out.push({ k, beats, from: now, to: best.fit });
      });
      return out;
    }
    return { noteFit, lineFit, songFit, autoFit, lineSuggestions, pc, hop };
  }

  // ---- Writing back: change only the numbers that changed, keep everything else byte for byte ----
  function fmtNum(x, original) {
    const s = Number.isInteger(x) ? String(x) : String(round2(x));
    return original && original.includes(',') ? s.replace('.', ',') : s;
  }
  function serialize(song, st) {
    const out = song.raw.slice();
    const changed = [];
    const setLine = (idx, s) => {
      const cr = out[idx].endsWith('\r') ? '\r' : '';
      const before = out[idx].replace(/\r$/, '');
      if (before !== s) { out[idx] = s + cr; changed.push({ idx, before, after: s }); }
    };
    const header = (name, value, orig) => {
      const h = song.headers[name];
      if (h) setLine(h.idx, '#' + h.key + ':' + fmtNum(value, h.value));
      else if (value !== orig) {
        const at = (song.headers.BPM || { idx: 0 }).idx + 1;
        out.splice(at, 0, '#' + name + ':' + fmtNum(value) + (out[0].endsWith('\r') ? '\r' : ''));
        changed.push({ idx: at, before: null, after: '#' + name + ':' + fmtNum(value) });
      }
    };
    // note lines first, by original index, so the insert above (rare) does not shift them
    song.notes.forEach((n, i) => {
      if (st.beat[i] === n.beat && st.len[i] === n.len) return;
      const m = NOTE_RE.exec(out[n.idx].replace(/\r$/, ''));
      setLine(n.idx, m[1] + m[2] + st.beat[i] + m[4] + st.len[i] + m[6] + m[7] + m[8]);
    });
    song.breaks.forEach((b, j) => {
      if (st.brk[j] === b.beat) return;
      const m = BREAK_RE.exec(out[b.idx].replace(/\r$/, ''));
      setLine(b.idx, '-' + m[1] + st.brk[j] + m[3]);
    });
    if (st.bpm !== song.bpm) header('BPM', st.bpm, song.bpm);
    if (st.gap !== song.gap) header('GAP', st.gap, song.gap);
    if (st.videoGap !== song.videoGap) header('VIDEOGAP', st.videoGap, song.videoGap);
    return { text: out.join('\n'), changed: changed.sort((a, b) => a.idx - b.idx) };
  }

  return { parse, initialState, apply, replay, spb, timeOfBeat, beatOfTime, noteStart, noteEnd, lineStart, lineEnd, solveTwoPoints, fitLine, buildMatcher, serialize, round2 };
})();
if (typeof module !== 'undefined') module.exports = Timing;
