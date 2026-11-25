// What can hold the Stage's focus, and where it lands in a layer.

/** Buttons and `[data-stage-focus]` elements hold the focus. */
export const FOCUSABLE = "button, [data-stage-focus]";

export function focusablesIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/** Focuses the layer's `[data-stage-default]` element (or the first inside it), else its first. */
export function focusDefault(root: Element): void {
  const marked = root.querySelector("[data-stage-default]");
  const target =
    (marked?.matches(FOCUSABLE) ? marked : marked?.querySelector(FOCUSABLE)) ??
    root.querySelector(FOCUSABLE);
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

/** A field that takes typed text: there, keys are the field's, not the Stage's. */
export function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "submit"].includes(
    element.type,
  );
}
