import { describe, expect, it } from "vitest";

// v1 spec #45: the Stage's sofa interface has no Admin area entry, and
// `/stage` is never navigated away from: on the Stage computer the Admin area
// opens in its own browser tab. So no Stage code names the Admin area's path,
// and Stage code imports no Admin area code, with one exception.
//
// The exception: Marc asked for Downloads on the Stage (2026-11-27), because
// the Stage computer is sometimes a TV with no second tab at hand. The Setup
// menu's Downloads overlay (`stage/overlays/DownloadsOverlay.tsx`) shows the
// Admin area's Downloads section in place, still without navigating, and
// starting a Download there stays guarded by the Admin PIN. That file may
// import `admin/Downloads`, and nothing else from `admin/`; and the Downloads
// section, with the Admin area modules it pulls in, never navigates either.
const stageSources = import.meta.glob<string>(
  ["../stage/**/*.{ts,tsx}", "!../stage/**/*.test.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

const DOWNLOADS_OVERLAY = "../stage/overlays/DownloadsOverlay.tsx";

/** The Admin area modules the Downloads section brings onto the Stage. */
const downloadsSources = import.meta.glob<string>(
  [
    "./Downloads.tsx",
    "./DownloadList.tsx",
    "./VideoPicker.tsx",
    "./AdminSection.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
);

const ADMIN_IMPORT = /from\s+["'](?:\.\.\/)+admin\/([^"']+)["']/g;

function adminImports(source: string): string[] {
  return [...source.matchAll(ADMIN_IMPORT)].map((match) => match[1] ?? "");
}

describe("the Stage", () => {
  it("has Stage code to look at", () => {
    expect(Object.keys(stageSources).length).toBeGreaterThan(10);
    expect(DOWNLOADS_OVERLAY in stageSources).toBe(true);
  });

  it.each(Object.entries(stageSources))(
    "%s has no route or link to the Admin area",
    (file, source) => {
      expect(source).not.toMatch(/["'`]\/admin\b/);
      expect(adminImports(source)).toEqual(
        file === DOWNLOADS_OVERLAY ? ["Downloads"] : [],
      );
    },
  );

  it("would see an import of Admin area code", () => {
    expect(adminImports('import { Songs } from "../../admin/Songs";')).toEqual([
      "Songs",
    ]);
  });

  it.each(Object.entries(downloadsSources))(
    "%s, which the Stage's Downloads overlay shows, navigates nowhere",
    (file, source) => {
      expect(file).toBeTruthy();
      expect(source).not.toMatch(/["'`]\/admin\b/);
      expect(source).not.toMatch(/@tanstack\/react-router/);
    },
  );

  it("checks every Admin area module the Downloads section imports", () => {
    const checked = new Set(
      Object.keys(downloadsSources).map((file) => file.slice(2, -4)),
    );
    for (const source of Object.values(downloadsSources)) {
      for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
        expect(checked).toContain(match[1]);
      }
    }
  });
});
