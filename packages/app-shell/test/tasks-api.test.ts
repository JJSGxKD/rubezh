import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { claimFailureKey, createTasksApi, isClaimable, openTaskLink, sortTasks, taskLink } from "../src/state/tasks-api";

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
});
