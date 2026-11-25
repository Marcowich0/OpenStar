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
