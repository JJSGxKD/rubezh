// Шаги сценария на странице. Отдельный модуль, чтобы проверять его на
// поддельной странице без браузера (scripts/test/screens.test.ts).

const STEP_TIMEOUT_MS = 10_000;

function describeStep(step) {
  if ("click" in step) return `нажать «${step.click}»`;
  return `дождаться «${step.waitText}»`;
}

/**
 * Исполняет шаги по порядку. Сломавшийся шаг называет сценарий и сам шаг:
 * по сообщению видно, где сценарий разошёлся с интерфейсом.
 */
export async function runSteps(page, scenario) {
  for (const step of scenario.steps ?? []) {
    try {
      if ("click" in step) await page.getByText(step.click, { exact: true }).click({ timeout: STEP_TIMEOUT_MS });
      else await page.waitForSelector(`text=${step.waitText}`, { timeout: STEP_TIMEOUT_MS });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(`сценарий ${scenario.id}, шаг «${describeStep(step)}»: ${reason}`);
    }
  }
}
