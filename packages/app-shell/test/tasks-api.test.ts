import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createTasksApi } from "../src/state/tasks-api";

// Клиент заданий (docs/35-stage4-plan.md WP13): цели с прогрессом — GET,
// забор — POST без тела с id в адресе; ответ разбирается схемой, незнакомый
// вид цели от сервера новее клиента принимается.

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

  it("id в адресе экранируется, а срок вне известных — отказ схемы, а не молча пустой раздел", async () => {
    const sent: Sent[] = [];
    await createTasksApi(server(sent, { claimed: false, credited: { coins: 0, gems: 0, shards: 0 }, tasks: [] })).claim("a/b");
    expect(sent[0]?.path).toBe("/api/v1/tasks/a%2Fb/claim");

    const broken = await createTasksApi(server([], { tasks: [{ ...TASK, period: "monthly" }] })).view();
    expect(broken.ok).toBe(false);
  });
});
