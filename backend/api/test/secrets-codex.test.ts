import { describe, expect, it } from "vitest";
import { SECRET_KINDS } from "../../../packages/shared-types/src/index";
import { Prisma } from "../src/generated/prisma/client.js";
import { SECRETS_CODEX_KINDS, SECRETS_CODEX_REWARD_TASK_ID, newKinds, secretsKindsAmount, type SecretKind } from "../src/modules/secrets-codex/secrets-codex-rules.js";
import type { SecretsCodexRepository } from "../src/modules/secrets-codex/secrets-codex.repository.js";
import { SecretsCodexService } from "../src/modules/secrets-codex/secrets-codex.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { STATE_KINDS, TASK_KIND_IDS, isStateKind, taskDefSchema } from "../src/modules/tasks/task-rules.js";
import type { TasksService } from "../src/modules/tasks/tasks.service.js";
import { WIPE_ORDER, WIPE_PLAN } from "../src/modules/wipe/wipe-plan.js";

// Кодекс тайников (tasks/T-0261, design/art/meta-v2.md §5.3): чистые правила —
// какие виды забег открывает впервые и сколько их у игрока. Таблица, запись по
// итогу забега, ручка и достижение — на живой базе,
// `secrets-codex.integration.test.ts`.

describe("новые виды кодекса", () => {
  it("вид не из списка отброшен: итог забега приходит со слов клиента", () => {
    expect(newKinds({ secretsFound: ["nobody", "shrine"] as readonly string[] as readonly SecretKind[] }, new Set())).toEqual(["shrine"]);
    expect(newKinds({ secretsFound: ["nobody"] as readonly string[] as readonly SecretKind[] }, new Set())).toEqual([]);
  });

  it("повтор во входе — один раз, уже найденный не возвращается", () => {
    expect(newKinds({ secretsFound: ["hoard", "hoard", "shrine"] }, new Set())).toEqual(["shrine", "hoard"]);
    expect(newKinds({ secretsFound: ["hoard", "shrine"] }, new Set(["shrine"]))).toEqual(["hoard"]);
    expect(newKinds({ secretsFound: ["shrine"] }, new Set(["shrine"]))).toEqual([]);
  });

  it("порядок — канонический (SECRET_KINDS), а не входа", () => {
    expect(newKinds({ secretsFound: ["wisp", "rift", "shrine"] }, new Set())).toEqual(["shrine", "rift", "wisp"]);
  });

  it("итог без поля и пустой итог — ничего", () => {
    expect(newKinds({}, new Set())).toEqual([]);
    expect(newKinds({ secretsFound: [] }, new Set())).toEqual([]);
  });
});

describe("список видов и движок", () => {
  it("копия списка в бэкенде равна SECRET_KINDS движка: новый вид без строки здесь роняет тест", () => {
    expect([...SECRETS_CODEX_KINDS]).toEqual([...SECRET_KINDS]);
  });

  it("каждый вид влезает в колонку базы", () => {
    for (const kind of SECRETS_CODEX_KINDS) expect(kind.length, kind).toBeLessThanOrEqual(16);
  });
});

describe("сколько видов найдено", () => {
  it("число найденных видов из списка, не больше шести", () => {
    expect(secretsKindsAmount(new Set())).toBe(0);
    expect(secretsKindsAmount(new Set(["shrine", "hoard"]))).toBe(2);
    expect(secretsKindsAmount(new Set(SECRET_KINDS))).toBe(SECRET_KINDS.length);
  });

  it("запись о виде, которого в списке нет, не считается", () => {
    expect(secretsKindsAmount(new Set(["shrine", "ghost"]))).toBe(1);
  });

  it("видов в игре шесть: цель достижения «Следопыт» — все", () => {
    expect(SECRET_KINDS).toHaveLength(6);
  });
});

describe("награда за кодекс: достижение, а не отдельная система", () => {
  it("вид secrets_kinds — состояние игрока с действием «максимум»", () => {
    expect(STATE_KINDS.secrets_kinds).toEqual({ op: "max" });
    expect(isStateKind("secrets_kinds")).toBe(true);
    expect(TASK_KIND_IDS).toContain("secrets_kinds");
  });

  it("строка каталога «Следопыт» разбирается, а фильтр и срок «неделя» ей запрещены", () => {
    const row = {
      taskId: "ach_secrets_all",
      period: "achievement",
      kind: "secrets_kinds",
      target: 6,
      title: "Следопыт",
      coins: 400,
      gems: 0,
      shards: 0,
      passPoints: 0,
      active: true,
      category: "collection",
      ladder: "secrets",
      rung: 1,
      prestige: 40,
      emblemTier: "epic",
    };
    expect(taskDefSchema.safeParse(row).success).toBe(true);
    expect(taskDefSchema.safeParse({ ...row, filter: { difficulty: "hard" } }).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...row, period: "weekly", category: null, ladder: null, rung: null, prestige: 0, emblemTier: null }).success).toBe(false);
  });

  it("награда — за все шесть", () => {
    expect(SECRETS_CODEX_REWARD_TASK_ID).toBe("ach_secrets_all");
  });
});

describe("вайп", () => {
  it("найденные тайники стираются вместе с прогрессом заданий", () => {
    expect(Object.values(Prisma.ModelName)).toContain("SecretFound");
    expect(WIPE_PLAN.SecretFound.action).toBe("wipe");
    expect(WIPE_ORDER).toContain("SecretFound");
  });
});

describe("слушатель забега", () => {
  const NOW = new Date("2026-11-13T12:00:00.000Z");

  /** Забег, который засчитывается заданиям: ничего лишнего, только то, что читает слушатель. */
  function recordedRun(patch: Partial<RecordedRun> = {}): RecordedRun {
    return {
      runId: "secrets-codex-unit-run",
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
      deathCause: null,
      cheats: false,
      continues: 0,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt: NOW,
      ...patch,
    };
  }

  function setup(alreadyFound: SecretKind[]) {
    const applied: { taskId: string; amount: number; op: string }[] = [];
    let recorded = 0;
    const repository: SecretsCodexRepository = {
      found: async () => alreadyFound.map((kind) => ({ kind, firstAt: NOW })),
      record: async (_accountId, kinds) => {
        recorded += kinds.length;
        return [...kinds];
      },
    };
    const tasks = {
      achievementDefs: async () => [{ taskId: "ach_secrets_all", period: "achievement", kind: "secrets_kinds", target: 6 }],
      applyState: async (_accountId: string, deltas: { taskId: string; amount: number; op: string }[]) => {
        for (const delta of deltas) applied.push({ taskId: delta.taskId, amount: delta.amount, op: delta.op });
      },
    } as unknown as TasksService;
    return { applied, recorded: () => recorded, service: new SecretsCodexService(repository, tasks, new RunsHooks()) };
  }

  it("два новых вида к двум найденным — прогресс «Следопыта» четыре, действие «максимум»", async () => {
    const { applied, service } = setup(["shrine", "hoard"]);
    await service.onRun(recordedRun({ secretsFound: ["hoard", "tree", "rift"] }));
    expect(applied).toEqual([{ taskId: "ach_secrets_all", amount: 4, op: "max" }]);
  });

  it("забег без тайников и пролог ничего не пишут", async () => {
    const { applied, recorded, service } = setup([]);
    await service.onRun(recordedRun({ secretsFound: [] }));
    await service.onRun(recordedRun({}));
    await service.onRun(recordedRun({ secretsFound: ["shrine"], mode: "prologue" }));
    expect(recorded()).toBe(0);
    expect(applied).toEqual([]);
  });

  it("забег с читами и отклонённый разбором тайников не открывают", async () => {
    const { applied, recorded, service } = setup([]);
    await service.onRun(recordedRun({ secretsFound: ["shrine"], cheats: true }));
    await service.onRun(recordedRun({ secretsFound: ["shrine"], verdict: "rejected" }));
    expect(recorded()).toBe(0);
    expect(applied).toEqual([]);
  });

  it("уже найденное повторно не пишется и прогресс не дописывается", async () => {
    const { applied, recorded, service } = setup(["shrine"]);
    await service.onRun(recordedRun({ secretsFound: ["shrine"] }));
    expect(recorded()).toBe(0);
    expect(applied).toEqual([]);
  });
});
