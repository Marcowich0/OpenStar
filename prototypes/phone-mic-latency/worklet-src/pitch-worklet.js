// PROTOTYPE, throwaway. Runs pitchy's McLeod Pitch Method in an AudioWorklet.
// Bundled into ../web/pitch-worklet.js by `npm run build` (esbuild).
import { PitchDetector } from "pitchy";

const WINDOW = 2048;

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.detect = options?.processorOptions?.detect !== false;
    this.clockF0 = null; // audio frames vs wall time, to see the audio clock fall behind
    this.clockD0 = 0;
    this.ring = new Float32Array(WINDOW);
    this.win = new Float32Array(WINDOW);
    this.pos = 0; // next write index in ring
    this.filled = 0;
    this.hop = Math.round(sampleRate * 0.01); // a reading about every 10 ms
    this.sinceLast = 0;
    this.detector = PitchDetector.forFloat32Array(WINDOW);
    this.detector.minVolumeDecibels = -100; // report everything; the Stage decides
    this.hasPerf = typeof performance !== "undefined";
    this.costSum = 0;
    this.costN = 0;
    this.costMax = 0;
    this.blocks = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    this.blocks++;
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.ring[this.pos] = ch[i];
      this.pos = (this.pos + 1) % WINDOW;
    }
    this.filled = Math.min(WINDOW, this.filled + ch.length);
    this.sinceLast += ch.length;
    if (this.filled < WINDOW || this.sinceLast < this.hop) return true;
    this.sinceLast = 0;

    // Linearise the ring: oldest sample first.
    const tail = WINDOW - this.pos;
    this.win.set(this.ring.subarray(this.pos), 0);
    this.win.set(this.ring.subarray(0, this.pos), tail);

    let sq = 0;
    for (let i = 0; i < WINDOW; i++) sq += this.win[i] * this.win[i];
    const rms = Math.sqrt(sq / WINDOW);

    const t0 = this.hasPerf ? performance.now() : 0;
    const [hz, clarity] = this.detect ? this.detector.findPitch(this.win, sampleRate) : [0, 0];
    if (this.hasPerf) {
      const c = performance.now() - t0;
      this.costSum += c;
      this.costN++;
      if (c > this.costMax) this.costMax = c;
    }

    // Frame index just after the newest sample in the window.
    const endFrame = currentFrame + ch.length;
    const wall = Date.now();
    const msg = {
      endFrame,
      wall,
      hz,
      clarity,
      db: rms > 0 ? 20 * Math.log10(rms) : -120,
    };
    if (this.costN >= 100) {
      msg.cost = { avg: this.costSum / this.costN, max: this.costMax, blocks: this.blocks };
      this.costSum = 0;
      this.costN = 0;
      this.costMax = 0;
    }
    if (this.clockF0 === null) { this.clockF0 = endFrame; this.clockD0 = wall; }
    else if (wall - this.clockD0 >= 2000) {
      const audioMs = ((endFrame - this.clockF0) / sampleRate) * 1000;
      msg.clock = { ratio: audioMs / (wall - this.clockD0), spanMs: wall - this.clockD0 };
      this.clockF0 = endFrame; this.clockD0 = wall;
    }
    this.port.postMessage(msg);
    return true;
  }
}

registerProcessor("pitch-processor", PitchProcessor);
