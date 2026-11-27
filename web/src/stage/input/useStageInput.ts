// The Stage's input beyond the keyboard and the mouse the frame already
// handles (spec #244): gamepads, and which device was used last, for the key
// hints. Mounted once by `StageScreen`.

import { useEffect } from "react";

import { startGamepadInput } from "./gamepad";
import { trackInputDevices } from "./inputDevice";

export function useStageInput() {
  useEffect(() => {
    const stopTracking = trackInputDevices();
    const stopGamepad = startGamepadInput();
    return () => {
      stopGamepad();
      stopTracking();
    };
  }, []);
}
