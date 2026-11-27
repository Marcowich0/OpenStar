// The voice processing this browser opens its Phone mic with: `standard`
// unless someone chose another in the mic diagnostics to compare. A per-
// browser convenience in `localStorage`; storage that is missing or blocked
// counts as `standard`.

import {
  isMicProcessing,
  type MicProcessing,
} from "../../pitch/capture/micDiagnostics";

const KEY = "openstar.phoneMicProcessing";

export function storedMicProcessing(): MicProcessing {
  try {
    const value = localStorage.getItem(KEY);
    return isMicProcessing(value) ? value : "standard";
  } catch {
    return "standard";
  }
}

export function storeMicProcessing(processing: MicProcessing): void {
  try {
    if (processing === "standard") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, processing);
  } catch {
    // Not kept: this page still uses it until it reloads.
  }
}
