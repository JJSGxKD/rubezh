import type { NetworkTaskLink, NetworkTaskOpen, PlatformAdapter } from "@bh/shared-types";

/**
 * Переход по заданию ленты сети (docs/35-stage4-plan.md WP13, часть 6).
 * Ссылка задания в ленте обмена Taddy — адрес самой Taddy: на него шлют
 * POST, а в ответ приходит адрес перехода — бот, приложение или страница.
 * Так делает SDK Taddy (`exchange.open`, 1.2.12), так делаем и мы, и именно
 * из клиента игрока: переход Taddy считает по его адресу и браузеру, а
 * запросы с одного адреса нашего сервера за всех игроков выглядели бы
 * накруткой.
 *
 * SDK Taddy для этого не нужен: он поднимается для учёта аудитории и может
 * не подняться, а переход — один запрос.
 */

/** Сколько ждём адрес перехода: игрок нажал кнопку и ждёт, а площадка открывает ссылки вскоре после нажатия. */
export const RESOLVE_TIMEOUT_MS = 5_000;

/** Срез `fetch`, который нужен переходу, — подменяется в тестах. */
export type TaskLinkFetch = (url: string, init: RequestInit) => Promise<Response>;

function isHttps(value: string): boolean {
  if (value.length > 2048 || !URL.canParse(value)) return false;
  return new URL(value).protocol === "https:";
}

/** Адрес из ответа сети `{ result }`: только строка и только https — `javascript:` и `http:` площадка не откроет. */
function resultUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("result" in body)) return null;
  const { result } = body;
  return typeof result === "string" && isHttps(result) ? result : null;
}

/** Адрес перехода по заданию ленты; `null` — сеть незнакома, не ответила или не отдала годного адреса. */
export async function resolveTaskLink(task: NetworkTaskLink, fetchImpl: TaskLinkFetch = fetch): Promise<string | null> {
  // Задания ленты сейчас только у Taddy; у другой сети переход может быть устроен иначе.
  if (task.network !== "taddy" || !isHttps(task.link)) return null;
  try {
    const response = await fetchImpl(task.link, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      // Тело — как у SDK Taddy: список полей ответа пуст.
      body: JSON.stringify({ fields: [] }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return resultUrl(await response.json());
  } catch (error: unknown) {
    // Сеть не ответила или ответила не JSON — перехода нет, строка скажет «не открылось».
    console.warn("Задание сети не открылось:", error);
    return null;
  }
}

/**
 * Открыть задание ленты: адрес перехода — у сети, открывает его адаптер,
 * как любую внешнюю ссылку, — бот внутри Telegram. Адаптер приходит
 * аргументом, чтобы первая загрузка несла один вызов чанка, а не код
 * перехода.
 */
export async function openTaskInBrowser(task: NetworkTaskLink, adapter: Required<Pick<PlatformAdapter, "openLink">>): Promise<NetworkTaskOpen> {
  const url = await resolveTaskLink(task);
  if (url === null) return "failed";
  adapter.openLink(url);
  return "opened";
}
