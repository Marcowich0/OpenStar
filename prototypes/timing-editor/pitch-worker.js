// PROTOTYPE (throwaway): offline pitch track of the whole Song for the Timing editor.
// YIN over the mixed audio, one frame every 10 ms. Runs as a Web Worker in the page,
// and as a plain module under node for checking.
function detectPitch(x, sr, onProgress) {
  const hop = Math.round(sr / 100), W = Math.round(sr * 0.025);
  const tauMin = Math.floor(sr / 700), tauMax = Math.ceil(sr / 75);
  const N = Math.max(0, Math.floor((x.length - W - tauMax) / hop));
  const pitch = new Float32Array(N), env = new Float32Array(N);
  for (let f = 0; f < N; f++) {
    const o = f * hop; let e = 0;
    for (let j = 0; j < W; j++) e += x[o + j] * x[o + j];
    env[f] = Math.sqrt(e / W);
  }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const gate = 0.08 * sorted[Math.floor(sorted.length * 0.95)];
  const d = new Float32Array(tauMax + 1), cm = new Float32Array(tauMax + 1);
  for (let f = 0; f < N; f++) {
    if (onProgress && f % 2000 === 0) onProgress(f / N);
    if (env[f] < gate) continue;
    const o = f * hop;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const v = x[o + j] - x[o + j + tau]; s += v * v; }
      d[tau] = s;
    }
    let run = 0, found = -1;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
    for (let tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < 0.35) { found = tau; break; }
    if (found < 0) continue;
    let t = found;
    while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
    const a = cm[t - 1], b = cm[t], c = t + 1 <= tauMax ? cm[t + 1] : b;
    const den = a - 2 * b + c;
    const tt = den !== 0 ? t + (a - c) / (2 * den) : t;
    pitch[f] = sr / tt;
  }
  return { pitch, env, hop: hop / sr };
}

if (typeof module !== 'undefined') module.exports = detectPitch;
else if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (e) => {
    const res = detectPitch(e.data.samples, e.data.sr, (p) => self.postMessage({ progress: p }));
    self.postMessage({ done: true, ...res }, [res.pitch.buffer, res.env.buffer]);
  };
}
