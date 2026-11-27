import { useEffect, useState } from "react";

/**
 * How many px of the bottom of the window the on-screen keyboard covers:
 * the window's height below the visible part of the page (the visual
 * viewport). A bar stuck to the bottom of the screen sits this far up to
 * stay above the keyboard. 0 where the browser resizes the page for the
 * keyboard itself, or has no visual viewport.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(measure);
  useEffect(() => {
    const viewport = globalThis.visualViewport;
    if (!viewport) return;
    const update = () => {
      setInset(measure());
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

function measure(): number {
  const viewport = globalThis.visualViewport;
  if (!viewport) return 0;
  const covered = window.innerHeight - (viewport.offsetTop + viewport.height);
  return Math.max(0, Math.round(covered));
}
