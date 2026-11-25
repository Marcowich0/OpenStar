// A stand-in `AudioContext` for tests: it records the audio graph (which node
// feeds which) instead of playing anything, so a test can follow the path a
// sound takes to the output.

export interface FakeNode {
  /** What the node is, for reading a path: "gain", "media", "destination", … */
  readonly kind: string;
  readonly gain: { value: number };
  /** The element a "media" node reads. */
  readonly element?: unknown;
  outputs: FakeNode[];
  connect(destination: FakeNode): FakeNode;
  disconnect(): void;
}

export interface FakeAudioContext {
  readonly destination: FakeNode;
  currentTime: number;
  outputLatency: number;
  baseLatency: number;
  state: "suspended" | "running" | "closed";
  /** Every node made, in order. */
  readonly nodes: FakeNode[];
  timestamp: AudioTimestamp;
  createGain(): FakeNode;
  createMediaElementSource(element: unknown): FakeNode;
  getOutputTimestamp(): AudioTimestamp;
  resume(): Promise<void>;
}

function node(kind: string, element?: unknown): FakeNode {
  const made: FakeNode = {
    kind,
    gain: { value: 1 },
    element,
    outputs: [],
    connect(destination) {
      made.outputs.push(destination);
      return destination;
    },
    disconnect() {
      made.outputs = [];
    },
  };
  return made;
}

export function fakeAudioContext(): FakeAudioContext {
  const sources = new Set<unknown>();
  const context: FakeAudioContext = {
    destination: node("destination"),
    currentTime: 0,
    outputLatency: 0.02,
    baseLatency: 0.005,
    state: "suspended",
    nodes: [],
    timestamp: { contextTime: 0, performanceTime: 0 },
    createGain() {
      const made = node("gain");
      context.nodes.push(made);
      return made;
    },
    createMediaElementSource(element) {
      // Like a browser: an element feeds at most one source node, ever.
      if (sources.has(element)) {
        throw new DOMException("already connected", "InvalidStateError");
      }
      sources.add(element);
      const made = node("media", element);
      context.nodes.push(made);
      return made;
    },
    getOutputTimestamp() {
      return context.timestamp;
    },
    resume() {
      context.state = "running";
      return Promise.resolve();
    },
  };
  return context;
}

/** The nodes a sound passes from `start` to a node with no outputs; throws where it forks. */
export function pathFrom(start: FakeNode): FakeNode[] {
  const path = [start];
  let at = start;
  while (at.outputs.length > 0) {
    if (at.outputs.length > 1) throw new Error(`${at.kind} feeds two nodes`);
    at = at.outputs[0] as FakeNode;
    path.push(at);
  }
  return path;
}

/** Use a fake as the real thing in code under test. */
export function asAudioContext(context: FakeAudioContext): AudioContext {
  return context as unknown as AudioContext;
}
