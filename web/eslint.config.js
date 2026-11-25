import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

import {
  COLOUR_LITERAL_ALLOWED,
  colourLiteralRule,
} from "./checks/colourLiterals.js";
import { apiPlugin, onlyTheWrapperFetches } from "./lint/apiRules.js";
import { openstarPlugin } from "./lint/noLiteralJsxText.js";

export default defineConfig(
  { ignores: ["dist", "src/generated"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.ts"],
          defaultProject: "tsconfig.node.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // Colours by palette key or token only (src/theme/tokens.ts).
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": colourLiteralRule },
  },
  {
    files: COLOUR_LITERAL_ALLOWED.filter((file) => !file.endsWith(".css")),
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // HTTP goes through the one typed wrapper, and nothing polls
    // (lint/apiRules.js).
    files: ["src/**/*.{ts,tsx}"],
    plugins: { api: apiPlugin },
    rules: {
      "no-restricted-globals": ["error", ...onlyTheWrapperFetches.globals],
      "no-restricted-properties": [
        "error",
        ...onlyTheWrapperFetches.properties,
      ],
      "api/no-polling": "error",
    },
  },
  {
    files: ["src/api/api.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
  {
    // Every word on screen goes through t() (src/i18n/t.ts). Tests and type
    // tests are not on screen.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/**/*.typetest.tsx"],
    plugins: { openstar: openstarPlugin },
    rules: { "openstar/no-literal-jsx-text": "error" },
  },
);
