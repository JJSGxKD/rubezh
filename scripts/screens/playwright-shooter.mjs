// Съёмка настоящим браузером. Подключается к установленным Edge или Chrome
// через playwright-core: сам пакет браузеров не скачивает
// (docs/17-testing-strategy.md §8).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runSteps } from "./steps.mjs";

/** Пауза после последнего шага: анимации выключены, но экран ещё дорисовывается. */
const SETTLE_MS = 400;
const NAVIGATION_TIMEOUT_MS = 30_000;

function firstLine(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

export async function createPlaywrightShooter({ browser: channel }) {
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.launch({ channel });
  } catch (error) {
    throw new Error(`браузер ${channel} не запустился (${firstLine(error)}). Поставьте Edge или Chrome, либо смените --browser`);
  }

  return {
    // Возвращает ошибки консоли страницы; сломанный шаг или адрес — исключение.
    async shoot(job) {
      const context = await browser.newContext({
        viewport: { width: job.width, height: job.height },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const consoleErrors = [];
      try {
        const page = await context.newPage();
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => consoleErrors.push(error.message));
        try {
          await page.goto(job.url, { waitUntil: "networkidle", timeout: NAVIGATION_TIMEOUT_MS });
        } catch (error) {
          throw new Error(`сценарий ${job.scenario.id}: адрес ${job.url} не открылся: ${firstLine(error)}`);
        }
        await runSteps(page, job.scenario);
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(SETTLE_MS);
        mkdirSync(dirname(job.file), { recursive: true });
        await page.screenshot({ path: job.file });
      } finally {
        await context.close();
      }
      return consoleErrors;
    },
    async close() {
      await browser.close();
    },
  };
}
