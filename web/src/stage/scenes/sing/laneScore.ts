// Writes a Player's running Score into their lane header (`[data-lane-score]`,
// rendered by `SingScreen`) straight to the DOM, so a Score change causes no
// React commit (#165). It changes the text node React rendered, so React's
// next render of the header (the lane's `score` is kept in step) agrees.

/** Shows `total` in lane `player`'s header under `root`, if it has one. */
export function writeLaneScore(
  root: ParentNode,
  player: number,
  total: number,
): void {
  const header = root.querySelectorAll("[data-lane-header]")[player];
  const score = header?.querySelector("[data-lane-score]");
  if (!score) return;
  // `<span data-lane-score><Score>` → the Score's span → its text.
  const text = score.firstElementChild?.firstChild ?? score.firstChild;
  const value = String(total);
  if (text?.nodeType === Node.TEXT_NODE) {
    if (text.nodeValue !== value) text.nodeValue = value;
  } else {
    (score.firstElementChild ?? score).textContent = value;
  }
}
