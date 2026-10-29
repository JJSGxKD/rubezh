// Снимки экранов одной командой: pnpm screens [сценарий…] [флаги].
// Серверы сам не поднимает: нужен запущенный `pnpm dev` с
// AUTH_DEV_LOGIN="true" (docs/17-testing-strategy.md §8). В гейт CI не входит.

import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./scenarios.mjs";

export const DEFAULT_BASE = "http://localhost:5173";
export const DEFAULT_OUT = "var/screens";
export const DEFAULT_SIZES = [
  [320, 568],
  [390, 844],
  [768, 1024],
  [1440, 900],
  [667, 375],
  [640, 360],
].map(([width, height]) => ({ width, height }));
// «id:Имя» — формат входа разработчика (T-0144): владелец с ролями и обычный игрок.
export const AS_USERS = { owner: "dev-shots:Снимки", player: "dev-player-shots:Игрок" };
const BROWSERS = ["msedge", "chrome"];
// Забегу нужен старт из листа, стресс-тесту — своя подготовка (state/dev-url.ts).
const NOT_OPENABLE = ["run", "stress"];
const CLIENT_TIMEOUT_MS = 5_000;

/** Список экранов читается из оболочки (SCREEN_IDS), чтобы не заводить второй. */
function readScreenIds() {
  const file = fileURLToPath(new URL("../../packages/app-shell/src/state/navigation.ts", import.meta.url));
  const body = /SCREEN_IDS = \[([\s\S]*?)\] as const/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return [...body.matchAll(/"(\w+)"/g)].map((match) => match[1]);
}

function parseSizes(value) {
  return value.split(",").map((part) => {
    const match = /^(\d+)x(\d+)$/.exec(part.trim());
    const width = match === null ? 0 : Number(match[1]);
    const height = match === null ? 0 : Number(match[2]);
    if (width <= 0 || height <= 0) throw new Error(`размер «${part}» не разобран: ждём <ширина>x<высота>, например 390x844`);
    return { width, height };
  });
}

const VALUE_FLAGS = ["--screen", "--sizes", "--as", "--browser", "--base", "--out"];

/** Разбор командной строки; ошибка — исключение с понятным сообщением. */
export function parseArgs(argv, platform = process.platform) {
  const flags = {};
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (!VALUE_FLAGS.includes(arg)) throw new Error(`неизвестный флаг ${arg}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`у флага ${arg} нет значения`);
      flags[arg] = value;
      i += 1;
    } else {
      names.push(arg);
    }
  }

  const as = flags["--as"] ?? "owner";
  if (!(as in AS_USERS)) throw new Error(`--as: «${as}» неизвестно, допустимо owner или player`);
  const browser = flags["--browser"] ?? (platform === "win32" ? "msedge" : "chrome");
  if (!BROWSERS.includes(browser)) throw new Error(`--browser: «${browser}» неизвестно, допустимо msedge или chrome`);

  const scenarios = names.map((name) => {
    const found = SCENARIOS.find((scenario) => scenario.id === name);
    if (found === undefined) throw new Error(`сценария «${name}» нет, есть: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    return found;
  });
  const screen = flags["--screen"];
  if (screen !== undefined) {
    if (NOT_OPENABLE.includes(screen)) throw new Error(`экран ${screen} адресом не открывается: забегу нужен старт из листа`);
    if (!readScreenIds().includes(screen)) throw new Error(`экрана «${screen}» нет в SCREEN_IDS (navigation.ts)`);
    scenarios.push({ id: screen, screen });
  }

  return {
    scenarios: scenarios.length > 0 ? scenarios : SCENARIOS,
    sizes: flags["--sizes"] === undefined ? DEFAULT_SIZES : parseSizes(flags["--sizes"]),
    as,
    devUser: AS_USERS[as],
    browser,
    base: flags["--base"] ?? DEFAULT_BASE,
    out: flags["--out"] ?? DEFAULT_OUT,
  };
}

/** План съёмки: по снимку на каждую пару «сценарий × размер». */
export function shotPlan(scenarios, sizes, out, { base, devUser }) {
  const plan = [];
  for (const scenario of scenarios) {
    for (const { width, height } of sizes) {
      const url = new URL(base);
      if (scenario.screen !== undefined) url.searchParams.set("screen", scenario.screen);
      url.searchParams.set("dev-user", devUser);
      plan.push({ scenario, width, height, file: join(out, `${scenario.id}-${width}x${height}.png`), url: url.toString() });
    }
  }
  return plan;
}

async function defaultFetchClient(base) {
  return fetch(base, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
}

async function defaultCreateShooter(options) {
  const { createPlaywrightShooter } = await import("./playwright-shooter.mjs");
  return createPlaywrightShooter(options);
}

/** Запуск; возвращает код выхода. Зависимости подменяются в тесте. */
export async function run(options, deps = {}) {
  const {
    fetchClient = defaultFetchClient,
    createShooter = defaultCreateShooter,
    mkdir: makeDir = mkdir,
    log = console.log,
  } = deps;

  try {
    const response = await fetchClient(options.base);
    if (!response.ok) throw new Error(`статус ${response.status}`);
  } catch {
    log(`Клиент на ${options.base} не отвечает — запустите pnpm dev`);
    return 1;
  }

  const plan = shotPlan(options.scenarios, options.sizes, options.out, options);
  await makeDir(options.out, { recursive: true });
  let shooter;
  try {
    shooter = await createShooter(options);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let failed = false;
  const consoleErrors = [];
  try {
    for (const job of plan) {
      try {
        const errors = await shooter.shoot(job);
        for (const text of errors) consoleErrors.push(`${job.scenario.id} ${job.width}x${job.height}: ${text}`);
        log(`снимок ${job.file}`);
      } catch (error) {
        failed = true;
        log(`ОШИБКА ${job.width}x${job.height}, ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await shooter.close();
  }

  if (consoleErrors.length > 0) {
    log(`\nОшибки консоли страницы (${consoleErrors.length}), на код выхода не влияют:`);
    for (const line of consoleErrors) log(`  ${line}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`pnpm screens: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exitCode = await run(options);
}
