// The top corners the frame's chrome holds over a scene, in reference-frame
// px from the frame's edge: the Line-up's back pill (`BrowseToggle.tsx`) in
// the top left, the Stage menu pills (`PillRow.tsx`) in the top right. A
// scene that draws in the top band keeps out of them (the Line-up's header,
// #247). Measured in Chromium with Fredoka (2026-11-27): the "◀ Song browser"
// pill ends 281 px from the left edge, and "Add songs · Queue 999 · People 12
// · Setup" starts 711 px from the right edge; each lane adds a gap of about
// 30 px beyond that. `e2e/tests/line-up-title.spec.ts` checks that a
// 120-character title stays clear of both, so a wider pill shows up there.

/** The back pill's corner: 48 px inset, the pill, and a gap. */
export const CHROME_LEFT_LANE = 340;

/** The Stage menu's corner: 48 px inset, the pills, and a gap. */
export const CHROME_RIGHT_LANE = 760;
