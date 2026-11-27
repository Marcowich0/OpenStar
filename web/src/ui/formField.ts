// Whether a key event belongs to a form field: there, the page's own
// shortcuts leave the keys alone.

/**
 * A field that keeps its own keys: an input of any type (React Aria's
 * checkboxes and radios focus one), a textarea, a select or editable text.
 */
export function isFormField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}
