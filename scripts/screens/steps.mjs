// Шаги сценария на странице. Отдельный модуль, чтобы проверять его на
// поддельной странице без браузера (scripts/test/screens.test.ts).

const STEP_TIMEOUT_MS = 10_000;
/** Сколько ждать необязательное окно: его либо показывают сразу после загрузки, либо нет вовсе. */
const OPTIONAL_STEP_TIMEOUT_MS = 3_000;

function describeStep(step) {
  if ("click" in step) return `нажать «${step.click}»`;
  if ("clickIfShown" in step) return `нажать «${step.clickIfShown}», если показано`;
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
      else if ("clickIfShown" in step) {
        // Окно первого запуска у свежего пользователя есть, у вернувшегося — нет: не показалось — шаг пропускается.
        const target = page.getByText(step.clickIfShown, { exact: true });
        const shown = await target.waitFor({ state: "visible", timeout: OPTIONAL_STEP_TIMEOUT_MS }).then(() => true, () => false);
        if (shown) await target.click({ timeout: STEP_TIMEOUT_MS });
      }
      else await page.waitForSelector(`text=${step.waitText}`, { timeout: STEP_TIMEOUT_MS });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(`сценарий ${scenario.id}, шаг «${describeStep(step)}»: ${reason}`);
    }
  }
}

const NAVIGATION_TIMEOUT_MS = 30_000;
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

/**
 * Самоподписанному сертификату dev-сервера доверяем только на локальном
 * хосте: для остальных адресов проверка сертификата обычная.
 */
export function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Настройки контекста браузера для снимка. */
export function contextOptions(job) {
  return {
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    ignoreHTTPSErrors: isLocalUrl(job.url),
  };
}

/**
 * Открывает адрес снимка. Ждём `domcontentloaded`, а не `load`: внешний
 * скрипт может не дать `load` наступить, а готовность экрана дальше
 * проверяют шаги сценария.
 */
export async function openJob(page, job) {
  try {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`сценарий ${job.scenario.id}: адрес ${job.url} не открылся: ${reason}`);
  }
}
