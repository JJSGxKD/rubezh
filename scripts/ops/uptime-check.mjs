import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseChatTarget, sendTelegramMessage } from "../release/team-summary.mjs";

/**
 * Внешняя проверка прода (docs/09-ci-cd.md, `uptime.yml`): адрес рабочий, если
 * ответил 200 за 10 секунд; вторая попытка через 5 секунд отсекает потерянный
 * пакет, и только вторая неудача считается падением. Сообщение уходит лишь при
 * смене состояния, а прежнее состояние — итог ближайшего прогона, давшего
 * ответ про прод (`stateOfRun`): хранить своё негде и не нужно.
 */

const ATTEMPTS = 2;
const GH_TIMEOUT_MS = 30_000;
const RUNS_SCANNED = 10;
const PREVIOUS_BUDGET_MS = 60_000;

/** Имена шагов uptime.yml: по ним следующий прогон отличает «прод лежит» от «упал сам прогон». */
export const CHECK_STEP = "Проверить прод";
export const DOWN_STEP = "Прод недоступен";

/** Состояние по итогу завершённого прогона: "up" | "down" | null — про прод прогон ничего не сказал. */
export function stateOfRun(conclusion, steps) {
  if (conclusion === "success") return "up";
  if (conclusion !== "failure") return null;
  return steps.some((step) => step.name === DOWN_STEP && step.conclusion === "failure") ? "down" : null;
}

/** Одна попытка: `null` — ответ 200, иначе причина. */
async function attempt(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(`нет ответа за ${Math.round(timeoutMs / 1000)} с`);
    }, timeoutMs);
  });
  const request = fetchImpl(url, { signal: controller.signal }).then(
    (response) => (response.status === 200 ? null : `HTTP ${response.status}`),
    (error) => {
      // Прерванный нами запрос уже описан таймером.
      if (controller.signal.aborted) return `нет ответа за ${Math.round(timeoutMs / 1000)} с`;
      return `ошибка сети: ${error?.cause?.code ?? error?.code ?? "неизвестно"}`;
    },
  );
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Один адрес: 200 за `timeoutMs` — `{ url, ok: true }`, иначе `{ url, ok: false, reason }`; две попытки с паузой. */
export async function checkUrl(url, { fetchImpl = fetch, timeoutMs = 10_000, retryDelayMs = 5_000, wait = (ms) => sleep(ms) } = {}) {
  let reason = "неизвестно";
  for (let n = 1; n <= ATTEMPTS; n++) {
    const failure = await attempt(url, fetchImpl, timeoutMs);
    if (failure === null) return { url, ok: true };
    reason = failure;
    if (n < ATTEMPTS) await wait(retryDelayMs);
  }
  // Только причина: текст тела и заголовки в сообщение не попадают.
  return { url, ok: false, reason };
}

/** Что сказать: `previous` — "up" | "down" | null (прогонов ещё не было), `results` — проверки адресов. */
export function decide(previous, results) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    const message = previous === "down" ? `🟢 Прод снова доступен: ${results.map((result) => result.url).join(", ")}` : null;
    return { state: "up", message };
  }
  const message =
    previous === "down"
      ? null
      : [
          "🔴 Прод недоступен",
          ...failed.map((result) => `${result.url} — ${result.reason}`),
          "Проверка из GitHub Actions; следующая — через 5 минут.",
        ].join("\n");
  return { state: "down", message };
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS }));
}

/** Прежнее состояние: ближайший прогон, давший ответ; отменённые и упавшие сами пропускаются. */
export function previousState(runGh = ghJson, { now = Date.now, budgetMs = PREVIOUS_BUDGET_MS } = {}) {
  const startedAt = now();
  try {
    const runs = runGh(["run", "list", "--workflow", "uptime.yml", "--status", "completed", "--limit", String(RUNS_SCANNED), "--json", "databaseId,conclusion"]);
    for (const run of runs) {
      const jobs = run.conclusion === "failure" ? (runGh(["run", "view", String(run.databaseId), "--json", "jobs"]).jobs ?? []) : [];
      const state = stateOfRun(run.conclusion, jobs.flatMap((job) => job.steps ?? []));
      if (state !== null) return state;
      // Долгий обход не должен съесть саму проверку.
      if (now() - startedAt > budgetMs) break;
    }
  } catch (error) {
    console.error(`прежнее состояние не получено: ${error instanceof Error ? error.message : error}`);
  }
  return null;
}

/** Вывод шага для workflow: по нему срабатывает шаг «Прод недоступен». */
export function writeStateOutput(state, file) {
  appendFileSync(file, `state=${state}\n`);
}

async function main() {
  const urls = (process.env.UPTIME_URLS ?? "").split(/\s+/).filter((url) => url !== "");
  if (urls.length === 0) {
    console.log("UPTIME_URLS не задана — проверять нечего");
    return;
  }

  const previous = previousState();
  const results = await Promise.all(urls.map((url) => checkUrl(url)));
  const { state, message } = decide(previous, results);
  console.log(`было: ${previous ?? "неизвестно"}, стало: ${state}`);
  for (const result of results) console.log(`${result.url} — ${result.ok ? "ok" : result.reason}`);

  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const target = parseChatTarget(process.env.TEAM_TELEGRAM_CHAT);
  if (message !== null) {
    if (token === "" || target === null) {
      console.log("сообщение не отправлено: не заданы TELEGRAM_BOT_TOKEN или TEAM_TELEGRAM_CHAT");
    } else {
      try {
        await sendTelegramMessage(token, target, message, { parseMode: null });
      } catch (error) {
        // Ошибка отправки на итог проверки не влияет: по нему следующий прогон узнаёт состояние.
        console.error(`сообщение не отправлено: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  // Результат — выводом шага, а не кодом выхода: падает следующий шаг workflow,
  // и по нему следующий прогон отличает «прод лежит» от «упал сам прогон».
  // Без workflow (ручной запуск) вывода нет — тогда код выхода, как раньше.
  const outputFile = process.env.GITHUB_OUTPUT ?? "";
  if (outputFile !== "") writeStateOutput(state, outputFile);
  else if (state === "down") process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
