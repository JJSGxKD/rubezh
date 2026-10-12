import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseChatTarget, sendTelegramMessage } from "../release/team-summary.mjs";

/**
 * Внешняя проверка прода (docs/09-ci-cd.md, `uptime.yml`): адрес рабочий, если
 * ответил 200 за 10 секунд; вторая попытка через 5 секунд отсекает потерянный
 * пакет, и только вторая неудача считается падением. Сообщение уходит лишь при
 * смене состояния, а прежнее состояние — итог прошлого завершённого прогона
 * этого же workflow: хранить своё негде и не нужно.
 */

const ATTEMPTS = 2;
const GH_TIMEOUT_MS = 30_000;

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

/** Итог прошлого завершённого прогона: `success` — "up", `failure` — "down", иначе `null`. */
function previousState() {
  try {
    const out = execFileSync("gh", ["run", "list", "--workflow", "uptime.yml", "--status", "completed", "--limit", "1", "--json", "conclusion"], {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    const conclusion = JSON.parse(out)[0]?.conclusion;
    if (conclusion === "success") return "up";
    if (conclusion === "failure") return "down";
  } catch (error) {
    console.error(`прежнее состояние не получено: ${error instanceof Error ? error.message : error}`);
  }
  return null;
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
  // Прогон, где прод упал, завершается с ошибкой: так следующий узнает прежнее состояние.
  if (state === "down") process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
