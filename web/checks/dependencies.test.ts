// @vitest-environment node

// The frontend's component and motion rules, as dependencies: OpenStar's own
// components on React Aria's headless primitives, no styled component kit, and
// no animation library (UI motion is CSS with the spring easing token).

import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const dependencies = Object.keys({
  ...manifest.dependencies,
  ...manifest.devDependencies,
});

const STYLED_KITS = [
  /^@mui\//,
  /^@material-ui\//,
  /^@chakra-ui\//,
  /^@mantine\//,
  /^antd$/,
  /^react-bootstrap$/,
  /^@radix-ui\/themes$/,
  /^@shadcn\//,
  /^daisyui$/,
  /^@headlessui\/tailwindcss$/,
];

const ANIMATION_LIBRARIES = [
  /^framer-motion$/,
  /^motion$/,
  /^@react-spring\//,
  /^react-spring$/,
  /^gsap$/,
  /^animejs$/,
  /^@formkit\/auto-animate$/,
  /^react-transition-group$/,
  /^popmotion$/,
];

it("builds components on React Aria Components", () => {
  expect(manifest.dependencies).toHaveProperty("react-aria-components");
});

it("has no styled component kit and no animation library", () => {
  const banned = dependencies.filter((name) =>
    [...STYLED_KITS, ...ANIMATION_LIBRARIES].some((pattern) =>
      pattern.test(name),
    ),
  );
  expect(banned).toEqual([]);
});

// One pitch detector: the Rust one (crates/detector), run in the browser as
// the detector-wasm module whose C ABI the worklet calls directly (#105).
const JAVASCRIPT_DETECTORS = [
  /^pitchy$/,
  /^pitchfinder$/,
  /^aubiojs$/,
  /^ml5$/,
  /^@tensorflow\//,
  /^crepe/,
  /pitch-?detect/,
];

const WASM_GLUE_GENERATORS = [
  /^wasm-bindgen/,
  /^wasm-pack$/,
  /^@wasm-tool\//,
  /^vite-plugin-wasm/,
  /^@rollup\/plugin-wasm$/,
  /^emscripten/,
];

it("has no JavaScript pitch detector beside the Rust one", () => {
  expect(
    dependencies.filter((name) =>
      JAVASCRIPT_DETECTORS.some((pattern) => pattern.test(name)),
    ),
  ).toEqual([]);
});

it("has no WASM glue generator: the worklet calls the exports itself", () => {
  expect(
    dependencies.filter((name) =>
      WASM_GLUE_GENERATORS.some((pattern) => pattern.test(name)),
    ),
  ).toEqual([]);
});
