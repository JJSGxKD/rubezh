import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchTasks, groupByPeriod, rewardLabel, saveTask, targetLabel, taskProblem, withKind, type TaskDef } from "../src/api/tasks";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Каталог заданий в панели (docs/35-stage4-plan.md Р52, WP13): форма
// проверяет то же, что сервер, пустой заголовок уходит как «по виду цели»,
// каталог — по срокам в порядке показа игроку.

function task(patch: Partial<TaskDef> = {}): TaskDef {
  return { taskId: "daily_runs", period: "daily", kind: "runs", params: null, target: 3, title: null, coins: 120, gems: 0, shards: 0, passPoints: 0, sort: 10, active: true, ...patch };
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

  describe("подписка на канал", () => {
    const channel = (patch: Partial<TaskDef> = {}) =>
      task({ taskId: "ach_channel", period: "achievement", kind: "channel", target: 1, coins: 0, gems: 15, params: { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" }, ...patch });

    it("выбор вида «канал» ставит достижение с целью 1 и пустой канал; другой вид канал убирает", () => {
      const picked = withKind(task({ taskId: "x_1", target: 5 }), "channel");
      expect(picked).toMatchObject({ kind: "channel", period: "achievement", target: 1, params: { platform: "telegram", chat: "", url: "" } });
      expect(withKind(picked, "kills")).toMatchObject({ kind: "kills", params: null });
    });

    it("форма требует канал и https-ссылку и не даёт копить подписку", () => {
      expect(taskProblem(channel(), true, [])).toBeNull();
      expect(taskProblem(channel({ params: null }), true, [])).toMatch(/площадка, канал и ссылка/);
      expect(taskProblem(channel({ period: "daily" }), true, [])).toMatch(/только достижение/);
      expect(taskProblem(channel({ target: 3 }), true, [])).toMatch(/только достижение/);
      expect(taskProblem(channel({ params: { platform: "telegram", chat: " ", url: "https://t.me/x" } }), true, [])).toMatch(/Канал/);
      expect(taskProblem(channel({ params: { platform: "telegram", chat: "@x_game", url: "http://t.me/x" } }), true, [])).toMatch(/Ссылка/);
      expect(taskProblem(channel({ params: { platform: "telegram", chat: "@x_game", url: "t.me/x" } }), true, [])).toMatch(/Ссылка/);
      expect(taskProblem(task({ taskId: "x_1", params: { platform: "telegram", chat: "@x", url: "https://t.me/x" } }), true, [])).toMatch(/только у подписки/);
    });

    it("канал уходит обрезанным, в списке цель — именем канала; старый сервер без параметров читается", async () => {
      const { fetch, calls } = fakeFetch(json(200, { data: channel() }), json(200, { data: { tasks: [{ ...task(), params: undefined }], kinds: ["runs"], periods: ["daily"] } }));
      const api = new AdminApi(fetch);
      await saveTask(api, channel({ params: { platform: "telegram", chat: " @rubezh_game ", url: " https://t.me/rubezh_game " } }));
      expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ params: { chat: "@rubezh_game", url: "https://t.me/rubezh_game" } });
      expect(targetLabel(channel())).toBe("@rubezh_game (Telegram)");

      const old = await fetchTasks(api);
      expect(old.ok && old.data.tasks[0]?.params).toBeNull();
    });
  });

  it("раздел — под правом tasks.edit", () => {
    expect(SECTIONS.find((section) => section.id === "tasks")?.permission).toBe("tasks.edit");
  });
});
