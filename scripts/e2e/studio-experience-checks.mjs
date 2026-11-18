import assert from "node:assert/strict";

const sizes = [
  [1440, 900],
  [1280, 800],
  [768, 1024],
  [390, 844],
  [360, 800],
];
const focused = (locator) =>
  locator.evaluate((el) => el === document.activeElement);

async function tabTo(page, target, key) {
  for (let i = 0; i < 30; i++) {
    if (await focused(target)) return;
    await page.keyboard.press(key);
  }
  assert.fail(
    "Keyboard traversal did not reach " + (await target.textContent()),
  );
}

export async function assertOnscreen(locator, viewport) {
  const box = await locator.boundingBox();
  assert(box && box.width > 0 && box.height > 0, "Control has no bounds");
  assert(
    box.x >= -1 && box.x + box.width <= viewport.width + 1,
    "Control clipped horizontally",
  );
  assert(
    box.y >= viewport.top - 1 && box.y + box.height <= viewport.bottom + 1,
    "Control outside visible viewport: " + JSON.stringify({ box, viewport }),
  );
  assert(
    await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
    "Control is obscured",
  );
}

export async function checkStudioExperience({
  page,
  output,
  engine,
  browserVersion,
  touch,
}) {
  const report = {
    engine,
    browserVersion,
    viewports: [],
    keyboard: [],
    visualViewport: {},
  };
  report.device = await page.evaluate(() => ({
    devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
  }));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const prompt = page.getByRole("textbox", { name: "描述需求或修改" });
  // WebKit on macOS follows the default keyboard navigation preference.
  // Option+Tab includes links and buttons under that preference.
  const tabKey =
    engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  report.traversalKey = tabKey;
  const opener = button("分享 / 导出");
  const rail = page.getByRole("navigation", { name: "项目导航" });
  const close = button("关闭面板");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    const viewport = { width, top: 0, bottom: height };
    await prompt.fill("待发送的需求草稿");
    await assertOnscreen(prompt, viewport);
    await assertOnscreen(button("发送需求"), viewport);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    assert(overflow <= 1, "Horizontal shell overflow: " + overflow);
    await page.screenshot({
      path: new URL("viewport-" + width + "x" + height + ".png", output)
        .pathname,
    });
    // Establish a starting position and use actual keyboard events to reach
    // delivery from the wordmark, then feedback and versions from the rail.
    await page.getByRole("link", { name: "项目首页" }).focus();
    await tabTo(page, opener, tabKey);
    assert(
      await opener.evaluate(
        (el) =>
          el.matches(":focus-visible") &&
          parseFloat(getComputedStyle(el).outlineWidth) >= 2,
      ),
    );
    await page.keyboard.press("Enter");
    const region = (name) =>
      page.getByRole(width < 768 ? "dialog" : "complementary", {
        name,
        exact: true,
      });
    await region("交付").waitFor();
    assert(await focused(close), "Focus should enter delivery");
    await tabTo(page, button("导出 React"), tabKey);
    assert(await button("创建分享").isEnabled());
    assert(await button("导出 HTML").isEnabled());
    if (width < 768) {
      assert(await region("交付").evaluate((el) => el.matches(":modal")));
      assert(
        await prompt.evaluate(
          (el) => parseFloat(getComputedStyle(el).fontSize) >= 16,
        ),
      );
      await opener.focus();
      assert(
        !(await focused(opener)),
        "Background controls must be inert while the mobile drawer is open",
      );
      await page.screenshot({
        path: new URL("delivery-" + width + ".png", output).pathname,
      });
    }
    await page.keyboard.press("Escape");
    await region("交付").waitFor({ state: "hidden" });
    assert(await focused(opener), "Escape should restore the top bar trigger");

    for (const name of ["版本", "批注"]) {
      const trigger = rail.getByRole("button", { name, exact: true });
      await tabTo(page, trigger, tabKey);
      await page.keyboard.press("Enter");
      await region(name).waitFor();
      assert(await focused(close));
      if (name === "批注") {
        const feedback = region(name).getByRole("textbox", {
          name: "当前版本批注",
        });
        await tabTo(page, feedback, tabKey);
        await page.keyboard.type("keyboard comment");
        assert.equal(await feedback.inputValue(), "keyboard comment");
        await feedback.fill("");
        await close.focus();
      }
      await page.keyboard.press("Enter");
      await region(name).waitFor({ state: "hidden" });
      assert(
        await focused(trigger),
        "Closing " + name + " should restore the rail trigger",
      );
    }
    if (width < 768 && touch) {
      await opener.evaluate((el) => {
        delete el.dataset.testPointer;
        el.addEventListener(
          "pointerdown",
          (event) => {
            el.dataset.testPointer = event.pointerType;
          },
          { once: true },
        );
      });
      await opener.tap();
      const pointerType = await opener.getAttribute("data-test-pointer");
      assert.equal(pointerType, "touch");
      report.pointerType = pointerType;
      await region("交付").waitFor();
      await close.tap();
      await region("交付").waitFor({ state: "hidden" });
      assert(
        await focused(opener),
        "Touch dismissal should restore the actual trigger",
      );
    }
    assert.equal(await prompt.inputValue(), "待发送的需求草稿");
    report.viewports.push({
      width,
      height,
      overflow,
      panel: width < 768 ? "modal" : "sidebar",
    });
  }
  await page.setViewportSize({ width: 720, height: 450 });
  await prompt.focus();
  await assertOnscreen(prompt, { width: 720, top: 0, bottom: 450 });
  await assertOnscreen(button("发送需求"), { width: 720, top: 0, bottom: 450 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  );
  assert(
    await page
      .locator(".studio-shell")
      .evaluate((el) =>
        Array.from(el.querySelectorAll("*")).every(
          (node) => getComputedStyle(node).animationName === "none",
        ),
      ),
  );
  report.reflow = {
    referenceWidth: 1440,
    equivalentCSSWidth: 720,
    height: 450,
    reducedMotion: true,
  };
  await page.screenshot({
    path: new URL("reflow-720x450.png", output).pathname,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await prompt.focus();
  // Unlike shrinking the browser window, the keyboard may leave layout height
  // untouched. Override only its reported visual bounds and send the UA events.
  const original = await page.evaluate(() => {
    const vv = visualViewport;
    const prior = { height: vv.height, offsetTop: vv.offsetTop };
    Object.defineProperties(vv, {
      height: { configurable: true, value: 420 },
      offsetTop: { configurable: true, value: 32 },
    });
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
    return prior;
  });
  assert.equal(await page.evaluate(() => innerHeight), 844);
  await assertOnscreen(prompt, { width: 390, top: 32, bottom: 452 });
  await assertOnscreen(button("发送需求"), {
    width: 390,
    top: 32,
    bottom: 452,
  });
  assert(await focused(prompt));
  await prompt.dispatchEvent("compositionstart");
  await prompt.dispatchEvent("keydown", {
    key: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  await prompt.dispatchEvent("compositionend", { data: "需求" });
  assert.equal(await prompt.inputValue(), "待发送的需求草稿");
  await prompt.press("Shift+Enter");
  assert((await prompt.inputValue()).includes("\n"));
  await page.screenshot({
    path: new URL("visual-viewport-composition.png", output).pathname,
  });
  await page.evaluate(() => {
    delete visualViewport.height;
    delete visualViewport.offsetTop;
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));
  });
  const restored = await page.locator(".studio-shell").boundingBox();
  assert(Math.abs(restored.height - original.height) < 1);
  assert(await focused(prompt));
  report.visualViewport = {
    layoutHeight: 844,
    simulatedHeight: 420,
    simulatedOffsetTop: 32,
    restoredHeight: restored.height,
  };
  report.keyboard.push(
    "Tab to delivery, version and feedback, input a comment, Escape or Close restores exact trigger",
    "Synthetic IME candidate Enter preserved draft, Shift+Enter inserted a newline",
  );
  await prompt.fill("");
  await page.setViewportSize({ width: 1440, height: 900 });
  return report;
}
