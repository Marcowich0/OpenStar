import {
  ADMIN_PIN,
  STAGE_VIEWPORT,
  becomeStageWithPin,
  expect,
  test,
} from "../fixtures";

// Becoming the Stage needs the Admin PIN once per browser (#186). This spec
// uses a browser context of its own that is not remembered yet; every other
// spec gets a remembered one from the `stage` fixture. It makes one wrong
// guess only: the wrong-guess wait is shared by the whole run. It comes in
// from `/`, by the join pad's "Use this device as the Stage", as a browser
// whose owner did not type the address does.

test("a new browser goes from / to the Stage, gives the Admin PIN once, then becomes the Stage with no pad", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: STAGE_VIEWPORT,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const page = await context.newPage();
  // Records how opaque the Admin PIN dialog is on every frame from the one
  // it appears in, so the Stage heading behind it can never read through it
  // while it opens (#246). The dialog's own opacity times every ancestor's.
  await page.addInitScript(() => {
    const seen: number[] = [];
    (window as unknown as { pinDialogOpacity: number[] }).pinDialogOpacity =
      seen;
    const opacity = (element: Element | null): number => {
      let product = 1;
      for (let at = element; at !== null; at = at.parentElement)
        product *= Number(getComputedStyle(at).opacity);
      return product;
    };
    const sample = () => {
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="Admin PIN"]',
      );
      if (dialog !== null) seen.push(opacity(dialog));
      if (seen.length < 30) requestAnimationFrame(sample);
    };
    new MutationObserver((_, observer) => {
      if (
        document.querySelector('[role="dialog"][aria-label="Admin PIN"]') ===
        null
      )
        return;
      observer.disconnect();
      sample();
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Join the Party" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use this device as the Stage" })
    .click();
  await expect(page).toHaveURL(/\/stage$/);
  const pad = page.getByRole("dialog", { name: "Admin PIN" });
  await expect(pad).toBeVisible();
  // Fully opaque from its first frame on.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { pinDialogOpacity: number[] }).pinDialogOpacity
            .length,
      ),
    )
    .toBe(30);
  expect(
    Math.min(
      ...(await page.evaluate(
        () =>
          (window as unknown as { pinDialogOpacity: number[] })
            .pinDialogOpacity,
      )),
    ),
  ).toBe(1);
  // Before anything else: no Stage frame behind the pad.
  await expect(page.locator("[data-stage-frame]")).toHaveCount(0);

  // A wrong PIN is refused and the pad stays.
  const wrong = ADMIN_PIN === "0000" ? "1111" : "0000";
  for (const digit of wrong)
    await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "OK" }).click();
  await expect(pad.getByText("That is not the Admin PIN")).toBeVisible();
  await expect(page.locator("[data-stage-frame]")).toHaveCount(0);

  // The reusable step: the right PIN, and the Stage frame comes.
  await becomeStageWithPin(page);

  // Remembered: a reload, and a new tab in the same browser, show no pad.
  await page.reload();
  await expect(page.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  await expect(pad).toHaveCount(0);
  const again = await context.newPage();
  await again.goto("/stage");
  await expect(again.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  await expect(again.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);

  await context.close();
});
