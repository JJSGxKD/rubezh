import { describe, expect, it } from "vitest";
import { ENEMIES } from "../../../packages/core-game/src/content/enemies";
import { Prisma } from "../src/generated/prisma/client.js";
import { CODEX_ENEMY_IDS, CODEX_REWARD_TASK_ID, newEntries, percentOf } from "../src/modules/codex/codex-rules.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import type { CodexRepository } from "../src/modules/codex/codex.repository.js";
import { CodexService } from "../src/modules/codex/codex.service.js";
import { RunsHooks, enemiesSeenOf, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { STATE_KINDS, TASK_KIND_IDS, isStateKind, taskDefSchema } from "../src/modules/tasks/task-rules.js";
import type { TasksService } from "../src/modules/tasks/tasks.service.js";
import { WIPE_ORDER, WIPE_PLAN } from "../src/modules/wipe/wipe-plan.js";

// Кодекс врагов (tasks/T-0127, docs/39-retention-mechanics.md К2): чистые
// правила — процент, новые записи, сверка списка врагов с контентом движка.
// Таблица, запись по итогу забега и ответ ручки — на живой базе,
// `codex.integration.test.ts`.

describe("процент открытого кодекса", () => {
  it("целая часть от доли: 7 из 11 — 63, 11 из 11 — 100, 10 из 11 — 90", () => {
    expect(percentOf(7, 11)).toBe(63);
    expect(percentOf(11, 11)).toBe(100);
    expect(percentOf(10, 11)).toBe(90);
  });

  it("пустой список — ноль, а не деление на ноль; открыто больше, чем всего, — не выше ста", () => {
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(3, 0)).toBe(0);
    expect(percentOf(0, 11)).toBe(0);
    expect(percentOf(12, 11)).toBe(100);
  });
});

describe("новые записи кодекса", () => {
  const [first = "", second = "", third = ""] = CODEX_ENEMY_IDS;

  it("враг не из таблицы отброшен", () => {
    expect(newEntries({ enemiesSeen: ["nobody_here", first] }, new Set())).toEqual([first]);
    expect(newEntries({ enemiesSeen: ["nobody_here"] }, new Set())).toEqual([]);
  });

  it("повтор во входе — один раз", () => {
    expect(newEntries({ enemiesSeen: [first, first, first] }, new Set())).toEqual([first]);
  });

  it("уже открытый не возвращается", () => {
    expect(newEntries({ enemiesSeen: [first, second] }, new Set([first]))).toEqual([second]);
    expect(newEntries({ enemiesSeen: [first] }, new Set([first]))).toEqual([]);
  });

  it("порядок — таблицы, а не входа", () => {
    expect(newEntries({ enemiesSeen: [third, first, second] }, new Set())).toEqual([first, second, third]);
  });

  it("пустой итог — ничего", () => {
    expect(newEntries({ enemiesSeen: [] }, new Set())).toEqual([]);
  });
});

describe("список врагов кодекса и контент движка", () => {
  const content = ENEMIES.map((enemy) => enemy.id);

  it("в таблице каждый враг контента: новый враг без строки в CODEX_ENEMY_IDS ронял бы кодекс", () => {
    const missing = content.filter((id) => !CODEX_ENEMY_IDS.includes(id));
    expect(missing, `в CODEX_ENEMY_IDS нет врагов из content/enemies.ts: ${missing.join(", ")} — добавьте их id в таблицу`).toEqual([]);
  });

  it("в таблице нет лишнего: удалённый из контента враг не должен висеть в кодексе", () => {
    const extra = CODEX_ENEMY_IDS.filter((id) => !content.includes(id));
    expect(extra, `в CODEX_ENEMY_IDS есть id, которых нет в content/enemies.ts: ${extra.join(", ")} — уберите их`).toEqual([]);
  });

  it("id без повторов, каждый влезает в колонку", () => {
    expect(new Set(CODEX_ENEMY_IDS).size).toBe(CODEX_ENEMY_IDS.length);
    for (const id of CODEX_ENEMY_IDS) expect(id.length, id).toBeLessThanOrEqual(48);
  });

  it("входят элита, боссы и потомки делящихся", () => {
    expect(ENEMIES.some((enemy) => enemy.rank === "elite" && CODEX_ENEMY_IDS.includes(enemy.id))).toBe(true);
    expect(ENEMIES.some((enemy) => enemy.rank === "boss" && CODEX_ENEMY_IDS.includes(enemy.id))).toBe(true);
    expect(CODEX_ENEMY_IDS).toContain("splitter_slime");
  });
});

describe("кого встретил игрок в итоге забега", () => {
  it("объединение stats.enemiesSeen и ключей topKills без повторов", () => {
    const seen = enemiesSeenOf({
      enemiesSeen: ["boss_ram", "swarm_rat"],
      topKills: [
        { enemy: "swarm_rat", count: 40 },
        { enemy: "tank_ghoul", count: 3 },
      ],
    });
    expect([...seen].sort()).toEqual(["boss_ram", "swarm_rat", "tank_ghoul"]);
  });

  it("убитый встречен, даже если сборка не прислала enemiesSeen", () => {
    expect(enemiesSeenOf({ topKills: [{ enemy: "tank_ghoul", count: 1 }] })).toEqual(["tank_ghoul"]);
  });

  it("без статистики — пусто", () => {
    expect(enemiesSeenOf(undefined)).toEqual([]);
  });
});

describe("награда за кодекс: достижения, а не отдельная система", () => {
  it("вид codex_percent — состояние игрока с действием «максимум», как друзья и уровень аккаунта", () => {
    expect(STATE_KINDS.codex_percent).toEqual({ op: "max" });
    expect(isStateKind("codex_percent")).toBe(true);
    expect(TASK_KIND_IDS).toContain("codex_percent");
  });

  it("строка каталога с таким видом разбирается, а фильтр и срок «неделя» ей запрещены", () => {
    const row = {
      taskId: "ach_codex_30",
      period: "achievement",
      kind: "codex_percent",
      target: 30,
      title: "Первые наброски",
      coins: 100,
      gems: 0,
      shards: 0,
      passPoints: 0,
      active: true,
      category: "collection",
      ladder: "codex",
      rung: 1,
      prestige: 5,
    };
    expect(taskDefSchema.safeParse(row).success).toBe(true);
    expect(taskDefSchema.safeParse({ ...row, filter: { difficulty: "hard" } }).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...row, period: "weekly", category: null, ladder: null, rung: null, prestige: 0 }).success).toBe(false);
  });

  it("итоговая награда — за 100%", () => {
    expect(CODEX_REWARD_TASK_ID).toBe("ach_codex_100");
  });
});

describe("вайп и словарь событий", () => {
  it("записи кодекса стираются вместе с прогрессом заданий, дочерние — раньше родительских", () => {
    expect(Object.values(Prisma.ModelName)).toContain("CodexEntry");
    expect(WIPE_PLAN.CodexEntry.action).toBe("wipe");
    expect(WIPE_ORDER).toContain("CodexEntry");
  });

  it("клиентское событие codex_viewed: сколько открыто, сколько всего и можно ли забрать награду", () => {
    const schema = EVENT_DICTIONARY.codex_viewed.payload;
    expect(schema.safeParse({ opened: 7, total: 11, claimable: false }).success).toBe(true);
    expect(schema.safeParse({ opened: -1, total: 11, claimable: false }).success).toBe(false);
    expect(schema.safeParse({ opened: 7, total: 11 }).success).toBe(false);
  });
});

describe("слушатель забега: процент считается по списку сервера", () => {
  const NOW = new Date("2026-11-13T12:00:00.000Z");

  /** Забег, который засчитывается заданиям: ничего лишнего, только то, что читает слушатель. */
  function recordedRun(enemiesSeen: string[]): RecordedRun {
    return {
      runId: "codex-unit-run",
      accountId: "00000000-0000-4000-8000-000000000001",
      difficulty: "hard",
      outcome: "died",
      survivalSec: 400,
      level: 22,
      enemiesKilled: 400,
      startingWeaponId: "spark",
      weapons: [{ id: "spark", level: 3 }],
      boosts: [],
      xpCollected: 600,
      counters: null,
      enemiesSeen,
      deathCause: null,
      cheats: false,
      continues: 0,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt: NOW,
    };
  }

  function setup(alreadyOpened: string[]) {
    const applied: number[] = [];
    const opened = alreadyOpened.map((enemyId) => ({ enemyId, firstSeenAt: NOW }));
    const repository: CodexRepository = {
      opened: async () => opened,
      open: async (_accountId, ids) => [...ids],
    };
    const tasks = {
      achievementDefs: async () => [{ taskId: "ach_codex_30", period: "achievement", kind: "codex_percent", target: 30 }],
      applyState: async (_accountId: string, deltas: { amount: number }[]) => {
        for (const delta of deltas) applied.push(delta.amount);
      },
    } as unknown as TasksService;
    return { applied, service: new CodexService(repository, tasks, new RunsHooks()) };
  }

  it("запись о враге, которого убрали из контента, в процент не идёт: из списка открыто 2, лишняя запись не считается", async () => {
    const [first, second] = CODEX_ENEMY_IDS;
    const { applied, service } = setup(["враг_из_прошлого_поезда", first ?? ""]);
    await service.onRun(recordedRun([second ?? ""]));
    expect(applied).toEqual([percentOf(2, CODEX_ENEMY_IDS.length)]);
  });

  it("босс открывается неубитым: в итоге он есть только в enemiesSeen", async () => {
    const { applied, service } = setup([]);
    await service.onRun(recordedRun(enemiesSeenOf({ enemiesSeen: ["boss_ram"], topKills: [{ enemy: "swarm_rat", count: 40 }] })));
    expect(applied).toEqual([percentOf(2, CODEX_ENEMY_IDS.length)]);
  });
});
