import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import {
  NETWORK_TASK_CHECKS_MS,
  claimFailureKey,
  createTasksApi,
  feedActionKey,
  feedCheckNotice,
  isClaimable,
  isFeedTask,
  isOpenKind,
  networkTaskConfirmed,
  slotsText,
  openTaskLink,
  sortTasks,
  tabOf,
  taskLink,
} from "../src/state/tasks-api";

// Клиент заданий (docs/35-stage4-plan.md WP13): цели с прогрессом — GET,
// забор — POST без тела с id в адресе; ответ разбирается схемой, незнакомый
// вид цели от сервера новее клиента принимается. Цель «канал» (Р52) несёт
// ссылку, а отказ в заборе говорит, подписан ли игрок.

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

const TASK = {
  id: "daily_runs",
  period: "daily",
  kind: "runs",
  title: null,
  target: 3,
  value: 3,
  done: true,
  claimed: false,
  reward: { coins: 120, gems: 0, shards: 0 },
  passPoints: 0,
};

describe("клиент заданий", () => {
  it("задания — GET, забор — POST без тела; незнакомый вид с заголовком каталога принимается", async () => {
    const sent: Sent[] = [];
    const view = await createTasksApi(server(sent, { tasks: [TASK, { ...TASK, id: "join_channel", kind: "channel", title: "Подпишись на канал" }] })).view();
    expect(view.ok && view.data.tasks.map((task) => task.kind)).toEqual(["runs", "channel"]);

    const claim = await createTasksApi(server(sent, { claimed: true, credited: { coins: 120, gems: 0, shards: 0 }, tasks: [{ ...TASK, claimed: true }] })).claim("daily_runs");
    expect(claim.ok && claim.data).toMatchObject({ claimed: true, credited: { coins: 120 } });
    expect(sent).toEqual([
      { method: "GET", path: "/api/v1/tasks", body: undefined },
      { method: "POST", path: "/api/v1/tasks/daily_runs/claim", body: undefined },
    ]);
  });

  it("ссылка цели — с сервера; старый сервер без поля — цель без ссылки", async () => {
    const view = await createTasksApi(server([], { tasks: [TASK, { ...TASK, id: "ach_channel", kind: "channel", link: "https://t.me/rubezh_game" }] })).view();
    expect(view.ok && view.data.tasks.map((task) => taskLink(task))).toEqual([null, "https://t.me/rubezh_game"]);
  });

  it("открывается только https: javascript:, data: и мусор — не ссылка", () => {
    expect(taskLink({ link: "https://t.me/rubezh_game" })).toBe("https://t.me/rubezh_game");
    expect(taskLink({ link: "javascript:alert(1)" })).toBeNull();
    expect(taskLink({ link: "data:text/html,<b>x</b>" })).toBeNull();
    expect(taskLink({ link: "http://t.me/rubezh_game" })).toBeNull();
    expect(taskLink({ link: "t.me/rubezh_game" })).toBeNull();
    expect(taskLink({ link: null })).toBeNull();
    expect(taskLink({})).toBeNull();
  });

  it("ссылку открывает площадка, а без её метода — браузер", () => {
    const opened: string[] = [];
    openTaskLink("https://t.me/rubezh_game", { openLink: (url) => void opened.push(`площадка ${url}`) }, (url) => void opened.push(`браузер ${url}`));
    openTaskLink("https://t.me/rubezh_game", {}, (url) => void opened.push(`браузер ${url}`));
    expect(opened).toEqual(["площадка https://t.me/rubezh_game", "браузер https://t.me/rubezh_game"]);
  });

  it("отказ в заборе говорит, что делать: не выполнено, не подписан, проверка недоступна", () => {
    expect(claimFailureKey("task_not_done")).toBe("tasks.stale");
    expect(claimFailureKey("task_not_joined")).toBe("tasks.notJoined");
    expect(claimFailureKey("task_check_unavailable")).toBe("tasks.checkUnavailable");
    expect(claimFailureKey(undefined)).toBe("tasks.claimFailed");
    expect(claimFailureKey("rate_limited")).toBe("tasks.claimFailed");
  });

  it("id в адресе экранируется, а срок вне известных — отказ схемы, а не молча пустой раздел", async () => {
    const sent: Sent[] = [];
    await createTasksApi(server(sent, { claimed: false, credited: { coins: 0, gems: 0, shards: 0 }, tasks: [] })).claim("a/b");
    expect(sent[0]?.path).toBe("/api/v1/tasks/a%2Fb/claim");

    const broken = await createTasksApi(server([], { tasks: [{ ...TASK, period: "monthly" }] })).view();
    expect(broken.ok).toBe(false);
  });

  it("порядок: можно забрать — сверху, в работе — посередине, полученное — внизу; похожие цели рядом и по величине", () => {
    const task = (id: string, kind: string, target: number, done: boolean, claimed: boolean) => ({ ...TASK, id, kind, target, done, claimed });
    const sorted = sortTasks([
      task("claimed_runs", "runs", 3, true, true),
      task("kills_big", "kills", 5000, false, false),
      task("runs_10", "runs", 10, false, false),
      task("ready_kills", "kills", 100, true, false),
      task("kills_small", "kills", 1000, false, false),
      task("mystery", "elites", 1, false, false),
      task("runs_3", "runs", 3, false, false),
      task("ready_runs", "runs", 5, true, false),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["ready_runs", "ready_kills", "runs_3", "runs_10", "kills_small", "kills_big", "mystery", "claimed_runs"]);
    expect(isClaimable({ done: true, claimed: false })).toBe(true);
    expect(isClaimable({ done: true, claimed: true })).toBe(false);
    expect(isClaimable({ done: false, claimed: false })).toBe(false);
  });

  it("партнёрские цели — своей вкладкой; старый сервер без категории — по сроку; переход — POST с id в адресе", async () => {
    expect(tabOf({ category: "partner", period: "achievement" })).toBe("partner");
    expect(tabOf({ category: "achievement", period: "achievement" })).toBe("achievement");
    expect(tabOf({ period: "daily" })).toBe("daily");
    expect(isOpenKind("link") && isOpenKind("bot")).toBe(true);
    expect(isOpenKind("channel")).toBe(false);
    expect(claimFailureKey("task_not_opened")).toBe("tasks.notOpened");

    const sent: Sent[] = [];
    const opened = await createTasksApi(server(sent, { url: "https://t.me/partner_bot", tasks: [{ ...TASK, kind: "bot", category: "partner", link: "https://t.me/partner_bot" }] })).open("ach_bot");
    expect(opened.ok && opened.data.url).toBe("https://t.me/partner_bot");
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/tasks/ach_bot/open", body: undefined }]);
  });

  it("задания сетей — списком рядом с целями: задание для SDK или пауза; старый сервер без списка — его нет", async () => {
    const network = {
      network: "adsgram",
      title: "AdsGram",
      reward: { coins: 100, gems: 0, shards: 0 },
      doneToday: 1,
      dailyCap: 5,
      offer: { sessionId: "s1", network: "adsgram", blockId: "task-123", keys: {}, debug: false, expiresAt: "2026-10-04T09:00:00.000Z" },
      nextAt: null,
    };
    const view = await createTasksApi(server([], { tasks: [TASK], networks: [network, { ...network, network: "taddy", offer: null, nextAt: "2026-10-03T10:00:00.000Z" }] })).view();
    expect(view.ok && view.data.networks?.map((item) => [item.network, item.offer?.blockId ?? null, item.nextAt])).toEqual([
      ["adsgram", "task-123", null],
      ["taddy", null, "2026-10-03T10:00:00.000Z"],
    ]);
    const old = await createTasksApi(server([], { tasks: [TASK] })).view();
    expect(old.ok && old.data.networks).toBeUndefined();

    // Шаг воронки — ручкой показов рекламы; «выполнено» клиент не шлёт вовсе.
    const sent: Sent[] = [];
    await createTasksApi(server(sent, { ok: true })).networkStep("Ab12Cd34Ef56Gh78", "clicked");
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/ads/sessions/Ab12Cd34Ef56Gh78/result", body: { outcome: "clicked" } }]);
  });

  it("подтверждение сети — когда выполненных за сутки стало больше; ответа нет — ещё не подтверждено", () => {
    expect(networkTaskConfirmed({ doneToday: 1 }, { doneToday: 2 })).toBe(true);
    expect(networkTaskConfirmed({ doneToday: 1 }, { doneToday: 1 })).toBe(false);
    expect(networkTaskConfirmed({ doneToday: 1 }, undefined)).toBe(false);
    // Спрашиваем всё реже и не дольше полуминуты: дальше экран честно говорит «сеть ещё проверяет».
    expect([...NETWORK_TASK_CHECKS_MS].every((at, index, all) => index === 0 || at > (all[index - 1] ?? 0))).toBe(true);
    expect(NETWORK_TASK_CHECKS_MS.at(-1)).toBeLessThanOrEqual(30_000);
  });

  it("лента сети: задание — POST с подсказками клиента, только знакомыми; проверка — с сессией; ответы разбираются схемой", async () => {
    const sent: Sent[] = [];
    const task = {
      sessionId: "Ab12Cd34Ef56Gh78",
      network: "taddy",
      title: "Ферма котиков",
      description: null,
      image: "https://cdn.taddy.example/1.webp",
      action: "channel",
      link: "https://t.tadly.pro/v1/exchange/open/1",
      opened: false,
    };
    const item = await createTasksApi(server(sent, { kind: "task", task })).networkItem("taddy", { language: "pt-BR", premium: true });
    expect(item.ok && item.data).toEqual({ kind: "task", task });
    const done = await createTasksApi(server(sent, { kind: "done", doneToday: 2, nextAt: "2026-10-03T10:00:00.000Z" })).networkItem("taddy", { language: "<b>", premium: null });
    expect(done.ok && done.data).toEqual({ kind: "done", doneToday: 2, nextAt: "2026-10-03T10:00:00.000Z" });
    const check = await createTasksApi(server(sent, { result: "not_done", doneToday: 0, nextAt: null })).networkCheck("taddy", "Ab12Cd34Ef56Gh78", { language: null, premium: false });
    expect(check.ok && check.data.result).toBe("not_done");
    expect(sent).toEqual([
      { method: "POST", path: "/api/v1/tasks/networks/taddy/item", body: { language: "pt-BR", premium: true } },
      { method: "POST", path: "/api/v1/tasks/networks/taddy/item", body: {} },
      { method: "POST", path: "/api/v1/tasks/networks/taddy/check", body: { sessionId: "Ab12Cd34Ef56Gh78", premium: false } },
    ]);
    const broken = await createTasksApi(server([], { kind: "task", task: { ...task, link: undefined } })).networkItem("taddy", { language: null, premium: null });
    expect(broken.ok).toBe(false);
  });

  it("строка ленты: надпись кнопки по виду задания, подсказка после проверки; старый сервер — всё элемент сети", () => {
    expect([feedActionKey("bot"), feedActionKey("app"), feedActionKey("link"), feedActionKey("channel")]).toEqual(["tasks.startBot", "tasks.network.openApp", "tasks.go", "tasks.go"]);
    expect(feedCheckNotice("confirmed")).toBeNull();
    expect(feedCheckNotice("closed")).toBeNull();
    expect(feedCheckNotice("not_done")).toBe("tasks.network.notDone");
    expect(feedCheckNotice("unavailable")).toBe("tasks.network.unavailable");
    expect(feedCheckNotice("что-то новое")).toBe("tasks.network.unavailable");
    expect(isFeedTask({ delivery: "feed" })).toBe(true);
    expect(isFeedTask({ delivery: "element" })).toBe(false);
    expect(isFeedTask({ delivery: undefined })).toBe(false);
  });

  it("места в партнёрской цели: остаток, удержание места до конца мягкого часа, отказ по коду; старый сервер — без мест", async () => {
    const now = Date.parse("2026-10-03T12:00:00.000Z");
    expect(slotsText({ left: 37, total: 500, holdUntil: null }, now)).toEqual({ key: "tasks.slotsLeft", params: { left: 37, total: 500 } });
    expect(slotsText({ left: 0, total: 500, holdUntil: "2026-10-03T12:40:00.000Z" }, now)).toEqual({ key: "tasks.slotsHeld", params: { minutes: 40 } });
    expect(slotsText({ left: 0, total: 500, holdUntil: "2026-10-03T12:00:20.000Z" }, now)).toEqual({ key: "tasks.slotsHeld", params: { minutes: 1 } });
    expect(slotsText({ left: 0, total: 500, holdUntil: "2026-10-03T11:59:00.000Z" }, now)).toBeNull();
    expect(slotsText(null, now)).toBeNull();
    expect(slotsText(undefined, now)).toBeNull();
    expect(claimFailureKey("task_limit_reached")).toBe("tasks.limitReached");

    const view = await createTasksApi(server([], { tasks: [{ ...TASK, slots: { left: 3, total: 10, holdUntil: null } }, TASK] })).view();
    expect(view.ok && view.data.tasks.map((task) => task.slots)).toEqual([{ left: 3, total: 10, holdUntil: null }, undefined]);
  });
});
