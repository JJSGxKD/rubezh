import ruTasks from "../src/i18n/ru-tasks.json";
import "../src/i18n/tasks";
import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import {
  claimFailureKey,
  createTasksApi,
  isExternalChannel,
  openExternalBot,
  subscribeKey,
  type TaskItem,
} from "../src/state/tasks-api";

// Канал другой площадки (docs/35-stage4-plan.md Р188, tasks/T-0377): первая
// кнопка открывает бота площадки — сервер выдаёт ссылку с одноразовым кодом
// (`POST /tasks/:id/link`), её открывает адаптер площадки; вторая — «Проверить»
// — как у обычного канала. Отказы говорят, что делать.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

/** Сервер отвечает ошибкой с кодом, как `apiRequest` на не-2xx. */
function refusing(code: string | undefined, failure: "rejected" | "unavailable" | "offline" = "rejected"): ApiRequest {
  return async <T,>(): Promise<ApiResult<T>> => ({ ok: false, failure, ...(code === undefined ? {} : { code }) });
}

const CHANNEL = {
  id: "join_max",
  period: "achievement",
  category: "partner",
  kind: "channel",
  title: "Подпишись на канал в MAX",
  target: 1,
  value: 0,
  done: false,
  claimed: false,
  reward: { coins: 0, gems: 15, shards: 0 },
  passPoints: 0,
  link: "https://max.ru/rubezh",
  linkMode: "external",
  channelPlatform: "max",
} as const;

const text = (key: string): string => (ruTasks as Record<string, string>)[key] ?? `нет ключа ${key}`;

describe("поля задания-канала с сервера", () => {
  it("площадка канала и способ связи принимаются; старый сервер без полей — задание как раньше", async () => {
    const view = await createTasksApi(server([], { tasks: [CHANNEL, { ...CHANNEL, id: "join_tg", linkMode: "own", channelPlatform: "telegram" }, { ...CHANNEL, id: "old", linkMode: undefined, channelPlatform: undefined }] })).view();
    expect(view.ok && view.data.tasks.map((task) => [task.id, task.linkMode ?? null, task.channelPlatform ?? null])).toEqual([
      ["join_max", "external", "max"],
      ["join_tg", "own", "telegram"],
      ["old", null, null],
    ]);
    const bare = { ...CHANNEL } as Record<string, unknown>;
    delete bare.linkMode;
    delete bare.channelPlatform;
    const old = await createTasksApi(server([], { tasks: [bare] })).view();
    expect(old.ok && old.data.tasks[0]?.linkMode).toBeUndefined();
  });

  it("внешний канал — только при linkMode external", () => {
    expect(isExternalChannel(CHANNEL as unknown as TaskItem)).toBe(true);
    expect(isExternalChannel({ ...CHANNEL, linkMode: "own" } as unknown as TaskItem)).toBe(false);
    expect(isExternalChannel({ ...CHANNEL, linkMode: null } as unknown as TaskItem)).toBe(false);
    expect(isExternalChannel({ ...CHANNEL, linkMode: undefined } as unknown as TaskItem)).toBe(false);
  });
});

describe("первая кнопка: бот площадки", () => {
  it("надпись по площадке: бот MAX, сообщество VK; у своего канала и неизвестной площадки — прежняя «Подписаться»", () => {
    expect(subscribeKey(CHANNEL as unknown as TaskItem)).toBe("tasks.external.open.max");
    expect(text("tasks.external.open.max")).toBe("Открыть бота MAX");
    expect(subscribeKey({ ...CHANNEL, channelPlatform: "vk" } as unknown as TaskItem)).toBe("tasks.external.open.vk");
    expect(text("tasks.external.open.vk")).toBe("Открыть сообщество VK");
    expect(subscribeKey({ ...CHANNEL, linkMode: "own", channelPlatform: "telegram" } as unknown as TaskItem)).toBe("tasks.subscribe");
    expect(subscribeKey({ ...CHANNEL, channelPlatform: "icq" } as unknown as TaskItem)).toBe("tasks.subscribe");
  });

  it("подсказка под карточкой объясняет путь: бот, ссылка на канал, «Проверить»", () => {
    expect(text("tasks.external.hint")).toBe("Бот спросит разрешение и пришлёт ссылку на канал. Подпишись и вернись сюда — нажми «Проверить».");
  });

  it("нажатие зовёт POST /link задания и открывает присланную ссылку площадкой", async () => {
    const sent: Sent[] = [];
    const opened: string[] = [];
    const api = createTasksApi(server(sent, { url: "https://max.ru/rubezh_bot?start=Abcdefghij012345" }));
    const result = await openExternalBot(api, CHANNEL, (url) => void opened.push(url));
    expect(result).toEqual({ ok: true });
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/tasks/join_max/link", body: undefined }]);
    expect(opened).toEqual(["https://max.ru/rubezh_bot?start=Abcdefghij012345"]);
  });

  it("id в адресе экранируется", async () => {
    const sent: Sent[] = [];
    await openExternalBot(createTasksApi(server(sent, { url: "https://max.ru/b?start=x" })), { id: "a/b" }, () => undefined);
    expect(sent[0]?.path).toBe("/api/v1/tasks/a%2Fb/link");
  });

  it("не https и кривая ссылка не открываются: ответ сервера — граница системы", async () => {
    for (const url of ["javascript:alert(1)", "http://max.ru/b", "max.ru/b", ""]) {
      const opened: string[] = [];
      const result = await openExternalBot(createTasksApi(server([], { url })), CHANNEL, (link) => void opened.push(link));
      expect(result).toEqual({ ok: false, key: "tasks.claimFailed" });
      expect(opened).toEqual([]);
    }
  });

  it("бот площадки недоступен — свой текст, ссылка не открывается", async () => {
    const opened: string[] = [];
    const result = await openExternalBot(createTasksApi(refusing("link_unavailable", "unavailable")), CHANNEL, (url) => void opened.push(url));
    expect(result).toEqual({ ok: false, key: "tasks.external.unavailable" });
    expect(text("tasks.external.unavailable")).toBe("Бот площадки сейчас недоступен — попробуй позже");
    expect(opened).toEqual([]);
  });

  it("лимит выдачи и нет сети — общий текст", async () => {
    expect(await openExternalBot(createTasksApi(refusing("rate_limited")), CHANNEL, () => undefined)).toEqual({ ok: false, key: "tasks.claimFailed" });
    expect(await openExternalBot(createTasksApi(refusing(undefined, "offline")), CHANNEL, () => undefined)).toEqual({ ok: false, key: "tasks.claimFailed" });
  });
});

describe("«Проверить»: отказы", () => {
  it("связи нет — «Сначала открой бота и нажми «Начать»»", () => {
    expect(claimFailureKey("task_link_required")).toBe("tasks.external.linkRequired");
    expect(text("tasks.external.linkRequired")).toBe("Сначала открой бота и нажми «Начать»");
  });

  it("бот недоступен — свой текст; лимит частоты — общий; прежние коды не меняются", () => {
    expect(claimFailureKey("link_unavailable")).toBe("tasks.external.unavailable");
    expect(claimFailureKey("rate_limited")).toBe("tasks.claimFailed");
    expect(claimFailureKey("task_not_joined")).toBe("tasks.notJoined");
    expect(claimFailureKey("task_check_unavailable")).toBe("tasks.checkUnavailable");
    expect(claimFailureKey(undefined)).toBe("tasks.claimFailed");
  });
});
