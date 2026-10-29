// Шаги сценария на странице. Отдельный модуль, чтобы проверять его на
// поддельной странице без браузера (scripts/test/screens.test.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/** Ключи согласия первого запуска разбираются из install.ts, чтобы не дублировать строки. */
export function parseInstallKeys(text) {
  const pick = (re, name) => {
    const found = re.exec(text)?.[1];
    if (found === undefined) throw new Error(`в state/install.ts не найден ${name}: поправьте разбор в scripts/screens/steps.mjs`);
    return found;
  };
  return {
    accepted: pick(/ACCEPTED_KEY\s*=\s*"([^"]+)"/, "ACCEPTED_KEY"),
    notice: pick(/NOTICE_KEY\s*=\s*"([^"]+)"/, "NOTICE_KEY"),
    version: pick(/TEST_NOTICE_VERSION\s*=\s*(\d+)/, "TEST_NOTICE_VERSION"),
  };
}

export function readInstallKeys() {
  const file = fileURLToPath(new URL("../../packages/app-shell/src/state/install.ts", import.meta.url));
  return parseInstallKeys(readFileSync(file, "utf8"));
}

/**
 * Принятое согласие первого запуска кладётся в localStorage до загрузки
 * страницы: иначе у свежего пользователя «Понятно, играем» запускает
 * обучающий забег, и лобби не снять.
 */
export async function seedConsent(context, keys = readInstallKeys()) {
  await context.addInitScript(
    ({ accepted, notice, version }) => {
      try {
        localStorage.setItem(accepted, "1");
        localStorage.setItem(notice, version);
      } catch {
        // хранилище недоступно — окно покажется, и его закроет шаг сценария
      }
    },
    keys,
  );
}

/** Новая страница с засеянным согласием; `attach` вешает слушатели до перехода. */
export async function openSeededPage(context, job, attach = () => undefined) {
  await seedConsent(context);
  const page = await context.newPage();
  attach(page);
  await openJob(page, job);
  return page;
}
