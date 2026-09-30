import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchTasks, groupByPeriod, rewardLabel, saveTask, targetLabel, taskProblem, type TaskDef } from "../src/api/tasks";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Каталог заданий в панели (docs/35-stage4-plan.md Р52, WP13): форма
// проверяет то же, что сервер, пустой заголовок уходит как «по виду цели»,
// каталог — по срокам в порядке показа игроку.

function task(patch: Partial<TaskDef> = {}): TaskDef {
  return { taskId: "daily_runs", period: "daily", kind: "runs", target: 3, title: null, coins: 120, gems: 0, shards: 0, passPoints: 0, sort: 10, active: true, ...patch };
}

describe("задания в панели", () => {
  it("каталог и сохранение — по своим адресам; пустой заголовок уходит как null, id обрезается", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { tasks: [task()], kinds: ["runs", "kills"], periods: ["daily", "weekly", "achievement"] } }), json(200, { data: task() }));
    const api = new AdminApi(fetch);

    const list = await fetchTasks(api);
    expect(list.ok && list.data.kinds).toEqual(["runs", "kills"]);
    expect(calls[0]?.url).toBe("/api/v1/admin/tasks");

    await saveTask(api, task({ taskId: " daily_runs ", title: "   " }));
    expect(calls[1]?.url).toBe("/api/v1/admin/tasks");
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ taskId: "daily_runs", title: null, coins: 120 });
  });

  it("форма не пропустит кривой id, повтор id, пустую награду и нулевую цель", () => {
    const catalog = [task()];
    expect(taskProblem(task({ taskId: "daily_new" }), true, catalog)).toBeNull();
    expect(taskProblem(task({ taskId: "Daily New" }), true, catalog)).toMatch(/латиница/);
    expect(taskProblem(task(), true, catalog)).toMatch(/уже есть/);
    expect(taskProblem(task(), false, catalog)).toBeNull();
    expect(taskProblem(task({ taskId: "x_1", coins: 0 }), true, catalog)).toMatch(/Без награды/);
    expect(taskProblem(task({ taskId: "x_1", target: 0 }), true, catalog)).toMatch(/Цель/);
    expect(taskProblem(task({ taskId: "x_1", gems: -1 }), true, catalog)).toMatch(/неотрицательные/);
    expect(taskProblem(task({ taskId: "x_1", target: 2.5 }), true, catalog)).toMatch(/Цель/);
  });

  it("цель во времени — минутами, награда — одной строкой, каталог — по срокам и порядку", () => {
    expect(targetLabel(task({ kind: "survive_sec", target: 900 }))).toBe("15 мин");
    expect(targetLabel(task({ kind: "best_survival_sec", target: 90 }))).toBe("90 с");
    expect(targetLabel(task({ kind: "kills", target: 1000 }))).toBe("1000");
    expect(rewardLabel(task({ coins: 150, shards: 3 }))).toBe("150 мон. + 3 оск.");

    const groups = groupByPeriod([task({ taskId: "b", sort: 20 }), task({ taskId: "a", sort: 20 }), task({ taskId: "w", period: "weekly" }), task({ taskId: "c", sort: 5 })]);
    expect(groups.map((group) => [group.period, group.tasks.map((item) => item.taskId)])).toEqual([
      ["daily", ["c", "a", "b"]],
      ["weekly", ["w"]],
      ["achievement", []],
    ]);
  });

  it("раздел — под правом tasks.edit", () => {
    expect(SECTIONS.find((section) => section.id === "tasks")?.permission).toBe("tasks.edit");
  });
});
