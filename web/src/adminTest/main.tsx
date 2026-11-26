// The test-only Admin page (`web/admin-test.html`): the whole app, opened on
// `/admin`, with the test-only guarded action on the Admin area's home. Built
// only by `vite build --mode screenshots` into e2e/generated/, never into the
// binary; `e2e/tests/admin.spec.ts` serves it from there.

import { setAdminTestSlot } from "../admin/adminTestSlot";
import { TestGuardedAction } from "./TestGuardedAction";

setAdminTestSlot(<TestGuardedAction />);
window.history.replaceState(null, "", "/admin");
void import("../main");
