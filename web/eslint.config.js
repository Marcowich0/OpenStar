import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

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
    // Every word on screen goes through t() (src/i18n/t.ts). Tests and type
    // tests are not on screen.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/**/*.typetest.tsx"],
    plugins: { openstar: openstarPlugin },
    rules: { "openstar/no-literal-jsx-text": "error" },
  },
);
