import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  TASK_LIMIT_RANGE,
  cadenceLabel,
  completionsLabel,
  fetchTasks,
  groupByPeriod,
  networkTaskProblem,
  networkTaskState,
  rewardLabel,
  saveNetworkTask,
  saveTask,
  targetLabel,
  taskProblem,
  withKind,
  withPlatform,
  type NetworkTaskRow,
  type TaskDef,
  partnerPlatforms,
  togglePlatform,
} from "../src/api/tasks";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Каталог заданий в панели (docs/35-stage4-plan.md Р52, WP13): форма
// проверяет то же, что сервер, пустой заголовок уходит как «по виду цели»,
// каталог — по срокам в порядке показа игроку.

function task(patch: Partial<TaskDef> = {}): TaskDef {
  return { taskId: "daily_runs", period: "daily", kind: "runs", params: null, target: 3, title: null, coins: 120, gems: 0, shards: 0, passPoints: 0, sort: 10, active: true, limit: null, image: null, ...patch };
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
    expect(groups.map((group) => [group.group, group.tasks.map((item) => item.taskId)])).toEqual([
      ["daily", ["c", "a", "b"]],
      ["weekly", ["w"]],
      ["achievement", []],
      ["partner", []],
    ]);
  });

  describe("подписка на канал", () => {
    const channel = (patch: Partial<TaskDef> = {}) =>
      task({ taskId: "ach_channel", period: "achievement", kind: "channel", target: 1, coins: 0, gems: 15, params: { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" }, ...patch });

    it("выбор вида «канал» ставит достижение с целью 1 и пустой канал; другой вид канал убирает", () => {
      const picked = withKind(task({ taskId: "x_1", target: 5 }), "channel");
      expect(picked).toMatchObject({ kind: "channel", period: "achievement", target: 1, params: { platform: "telegram", chat: "", url: "" } });
      expect(withKind(picked, "kills")).toMatchObject({ kind: "kills", params: null });
      // повтор подписки переживает повторный выбор вида, а у ссылки его нет
      const daily = { ...picked, period: "daily" as const };
      expect(withKind(daily, "channel").period).toBe("daily");
      expect(withKind(daily, "link").period).toBe("achievement");
    });

    it("форма требует канал и https-ссылку и не даёт копить подписку; повтор — каждый день или каждую неделю", () => {
      expect(taskProblem(channel(), true, [])).toBeNull();
      expect(taskProblem(channel({ params: null }), true, [])).toMatch(/нужна ссылка/);
      expect(taskProblem(channel({ taskId: "channel_daily", period: "daily" }), true, [])).toBeNull();
      expect(taskProblem(channel({ taskId: "channel_weekly", period: "weekly" }), true, [])).toBeNull();
      expect(taskProblem(channel({ target: 3 }), true, [])).toMatch(/цель — 1/);
      expect(taskProblem(channel({ params: { platform: "telegram", chat: " ", url: "https://t.me/x" } }), true, [])).toMatch(/Канал/);
      expect(taskProblem(channel({ params: { platform: "telegram", chat: "@x_game", url: "http://t.me/x" } }), true, [])).toMatch(/Ссылка/);
      expect(taskProblem(channel({ params: { platform: "telegram", chat: "@x_game", url: "t.me/x" } }), true, [])).toMatch(/Ссылка/);
      expect(taskProblem(task({ taskId: "x_1", params: { platform: "telegram", chat: "@x", url: "https://t.me/x" } }), true, [])).toMatch(/только у партнёрских/);
    });

    it("канал уходит обрезанным, в списке цель — именем канала; старый сервер без параметров читается", async () => {
      const { fetch, calls } = fakeFetch(json(200, { data: channel() }), json(200, { data: { tasks: [{ ...task(), params: undefined }], kinds: ["runs"], periods: ["daily"] } }));
      const api = new AdminApi(fetch);
      await saveTask(api, channel({ params: { platform: "telegram", chat: " @rubezh_game ", url: " https://t.me/rubezh_game " } }));
      expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ params: { chat: "@rubezh_game", url: "https://t.me/rubezh_game" } });
      expect(targetLabel(channel())).toBe("@rubezh_game (Telegram)");
      expect(targetLabel(channel({ period: "daily" }))).toBe("@rubezh_game (Telegram) · каждый день");
      expect(targetLabel(channel({ period: "weekly" }))).toBe("@rubezh_game (Telegram) · каждую неделю");

      const old = await fetchTasks(api);
      expect(old.ok && old.data.tasks[0]?.params).toBeNull();
    });
  });

  describe("картинка партнёрской цели", () => {
    const channel = (patch: Partial<TaskDef> = {}) =>
      task({ taskId: "ach_channel", period: "achievement", kind: "channel", target: 1, coins: 0, gems: 15, params: { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" }, ...patch });

    it("картинка — у партнёрской цели; у цели забега её нет, смена вида её снимает; уходит на сервер, старый сервер без неё читается", async () => {
      const image = "a".repeat(64);
      expect(taskProblem(channel({ image }), true, [])).toBeNull();
      expect(taskProblem(task({ taskId: "x_1", image }), true, [])).toBe("Картинка — только у партнёрских целей");
      expect(withKind(channel({ image }), "kills").image).toBeNull();
      expect(withKind(channel({ image }), "link").image).toBe(image);

      const { fetch, calls } = fakeFetch(json(200, { data: channel({ image }) }), json(200, { data: { tasks: [{ ...channel(), image: undefined }], kinds: ["channel"], periods: ["achievement"] } }));
      const api = new AdminApi(fetch);
      await saveTask(api, channel({ image }));
      expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ image });
      const old = await fetchTasks(api);
      expect(old.ok && old.data.tasks[0]?.image).toBeNull();
    });
  });

  describe("лимит выполнений", () => {
    const channel = (patch: Partial<TaskDef> = {}) =>
      task({ taskId: "ach_channel", period: "achievement", kind: "channel", target: 1, coins: 0, gems: 15, params: { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" }, ...patch });

    it("лимит — у партнёрской цели, целым в пределах сервера; у цели забега его нет, смена вида его снимает", () => {
      expect(taskProblem(channel({ limit: 500 }), true, [])).toBeNull();
      expect(taskProblem(channel({ limit: 0 }), true, [])).toMatch(/Лимит выполнений — целое/);
      expect(taskProblem(channel({ limit: 2.5 }), true, [])).toMatch(/Лимит выполнений — целое/);
      expect(taskProblem(channel({ limit: TASK_LIMIT_RANGE.max + 1 }), true, [])).toMatch(/Лимит выполнений/);
      expect(taskProblem(task({ taskId: "x_1", limit: 10 }), true, [])).toMatch(/только у партнёрских/);
      expect(withKind(channel({ limit: 500 }), "runs").limit).toBeNull();
    });

    it("сколько выполнили — словами; лимит уходит на сервер, старый сервер без лимита и счёта читается", async () => {
      expect(completionsLabel(channel(), 12)).toEqual({ text: "12", exhausted: false });
      expect(completionsLabel(channel({ limit: 500 }), 37)).toEqual({ text: "37 из 500", exhausted: false });
      expect(completionsLabel(channel({ limit: 500 }), 501)).toEqual({ text: "501 из 500", exhausted: true });

      const { fetch, calls } = fakeFetch(json(200, { data: channel({ limit: 500 }) }), json(200, { data: { tasks: [{ ...channel(), limit: undefined }], kinds: ["channel"], periods: ["achievement"] } }));
      const api = new AdminApi(fetch);
      await saveTask(api, channel({ limit: 500 }));
      expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ limit: 500 });
      const old = await fetchTasks(api);
      expect(old.ok && [old.data.tasks[0]?.limit, old.data.completions]).toEqual([null, {}]);
    });
  });

  describe("переход по ссылке и запуск бота", () => {
    const link = (patch: Partial<TaskDef> = {}) => task({ taskId: "ach_site", period: "achievement", kind: "link", target: 1, coins: 50, params: { url: "https://example.com/p" }, ...patch });

    it("вид «ссылка» и «бот» — достижение с целью 1, без канала; площадка необязательна", () => {
      const picked = withKind(task({ taskId: "x_1", params: null }), "bot");
      expect(picked).toEqual(expect.objectContaining({ kind: "bot", period: "achievement", target: 1, params: { url: "" } }));
      // площадка подписки переходит в список площадок ссылки
      expect(withKind(withKind(task({ taskId: "x_1" }), "channel"), "link").params).toEqual({ platforms: ["telegram"], url: "" });
      expect(withPlatform({ platform: "vk", url: "https://vk.com/x" }, undefined)).toEqual({ url: "https://vk.com/x" });
      expect(taskProblem(link(), true, [])).toBeNull();
      expect(taskProblem(link({ params: { url: "http://example.com" } }), true, [])).toMatch(/Ссылка/);
      expect(taskProblem(link({ period: "daily" }), true, [])).toMatch(/Повтор — только у подписки/);
      expect(taskProblem(link({ kind: "channel", params: { url: "https://t.me/x", chat: "@x_game" } }), true, [])).toMatch(/площадка/);
    });

    it("канал уходит только у подписки, пустая площадка не уходит; в списке — адресом; группа — партнёрские", async () => {
      const { fetch, calls } = fakeFetch(json(200, { data: link() }));
      await saveTask(new AdminApi(fetch), link({ params: { url: " https://example.com/p ", chat: "@stale" } }));
      expect(JSON.parse(String(calls[0]?.init.body)).params).toEqual({ url: "https://example.com/p" });
      expect(targetLabel(link())).toBe("example.com (все площадки)");
      expect(groupByPeriod([link(), task()]).find((group) => group.group === "partner")?.tasks.map((item) => item.taskId)).toEqual(["ach_site"]);
    });
  });

  describe("где видна ссылка или бот", () => {
    const link = (params: TaskDef["params"]) => task({ taskId: "ach_site", period: "achievement", kind: "link", target: 1, coins: 50, params });

    it("галочки площадок: список в порядке площадок, сняли последнюю — снова все", () => {
      let params = togglePlatform({ url: "https://example.com/p" }, "max");
      params = togglePlatform(params, "telegram");
      expect(params).toEqual({ platforms: ["telegram", "max"], url: "https://example.com/p" });
      expect(togglePlatform(togglePlatform(params, "max"), "telegram")).toEqual({ url: "https://example.com/p" });
      // запись прошлой панели с одной площадкой — список из неё
      expect(partnerPlatforms({ platform: "vk", url: "https://vk.com/x" })).toEqual(["vk"]);
      expect(togglePlatform({ platform: "vk", url: "https://vk.com/x" }, "web")).toEqual({ platforms: ["vk", "web"], url: "https://vk.com/x" });
    });

    it("уходит списком без старого поля, в списке каталога — площадками", async () => {
      const { fetch, calls } = fakeFetch(json(200, { data: link({ platforms: ["telegram", "max"], url: "https://example.com/p" }) }));
      await saveTask(new AdminApi(fetch), link({ platform: "vk", url: "https://example.com/p" }));
      expect(JSON.parse(String(calls[0]?.init.body)).params).toEqual({ platforms: ["vk"], url: "https://example.com/p" });
      expect(targetLabel(link({ platforms: ["telegram", "max"], url: "https://example.com/p" }))).toBe("example.com (Telegram, MAX)");
      expect(targetLabel(link({ platforms: ["web"], url: "https://example.com/p" }))).toBe("example.com (Браузер)");
    });
  });

  describe("задания рекламных сетей", () => {
    const row: NetworkTaskRow = {
      networkKey: "adsgram",
      title: "AdsGram",
      active: true,
      dailyCap: 5,
      pauseMin: 30,
      coins: 100,
      gems: 0,
      shards: 0,
      updatedAt: "2026-10-03T04:00:00.000Z",
      updatedBy: null,
      ready: { block: true, blockTitle: "Task-блок", confirm: true, confirmWith: "Адрес награды за задание AdsGram", confirmSecret: true },
    };

    it("строки сетей приходят с каталогом; старый сервер без них — пустой список; правка — по ключу сети в адресе", async () => {
      const { fetch, calls } = fakeFetch(
        json(200, { data: { tasks: [], kinds: [], periods: ["daily", "weekly", "achievement"], networks: [row] } }),
        json(200, { data: { tasks: [], kinds: [], periods: ["daily", "weekly", "achievement"] } }),
        json(200, { data: { ...row, dailyCap: 3 } }),
      );
      const api = new AdminApi(fetch);
      const list = await fetchTasks(api);
      expect(list.ok && list.data.networks).toEqual([row]);
      const old = await fetchTasks(api);
      expect(old.ok && old.data.networks).toEqual([]);
      // Сервер до ленты Taddy готовность отдавал без вида блока и подтверждения — это был Task-блок AdsGram с ключом.
      const before = { block: row.ready.block, confirm: row.ready.confirm, confirmWith: row.ready.confirmWith };
      const parsed = await fetchTasks(new AdminApi(fakeFetch(json(200, { data: { tasks: [], kinds: [], periods: ["daily"], networks: [{ ...row, ready: before }] } })).fetch));
      expect(parsed.ok && parsed.data.networks[0]?.ready).toEqual(row.ready);
      await saveNetworkTask(api, { networkKey: "adsgram", active: true, dailyCap: 3, pauseMin: 30, coins: 100, gems: 0, shards: 0 });
      expect(calls[2]?.url).toBe("/api/v1/admin/tasks/networks/adsgram");
      expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ active: true, dailyCap: 3, pauseMin: 30, coins: 100, gems: 0, shards: 0 });
    });

    it("форма держит те же пределы, что сервер: потолок, пауза, награда", () => {
      const input = { networkKey: "adsgram", active: true, dailyCap: 5, pauseMin: 30, coins: 100, gems: 0, shards: 0 };
      expect(networkTaskProblem(input)).toBeNull();
      expect(networkTaskProblem({ ...input, dailyCap: 0 })).toMatch(/от 1 до 50/);
      expect(networkTaskProblem({ ...input, dailyCap: 2.5 })).toMatch(/от 1 до 50/);
      expect(networkTaskProblem({ ...input, pauseMin: 4 })).toMatch(/от 5 минут/);
      expect(networkTaskProblem({ ...input, coins: 0 })).toMatch(/Без награды/);
    });

    it("состояние словами: выключено, игроки не видят — чего не хватает, работает; частота — по-человечески", () => {
      expect(networkTaskState(row)).toEqual({ tone: "success", label: "Работает" });
      expect(networkTaskState({ ...row, active: false })).toEqual({ tone: "neutral", label: "Выключено" });
      expect(networkTaskState({ ...row, ready: { ...row.ready, confirm: false } })).toEqual({ tone: "warning", label: "Игроки не видят" });
      expect(networkTaskState({ ...row, ready: { ...row.ready, block: false } }).label).toBe("Игроки не видят");
      expect(cadenceLabel(row)).toBe("до 5 в сутки, пауза 30 мин");
      expect(cadenceLabel({ dailyCap: 1, pauseMin: 120 })).toBe("до 1 в сутки, пауза 2 ч");
    });
  });

  it("раздел — под правом tasks.edit", () => {
    expect(SECTIONS.find((section) => section.id === "tasks")?.permission).toBe("tasks.edit");
  });
});
