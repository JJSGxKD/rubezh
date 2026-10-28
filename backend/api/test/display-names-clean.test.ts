import { describe, expect, it } from "vitest";
import { cleanAll, parseCleanArgs, planCleanup, type CleanResult, type CleanupRow } from "../src/cli/display-names-clean.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { displayNameFor } from "../src/modules/auth/display-name.js";
import { compileNameRules } from "../src/modules/name-rules/name-rules-engine.js";

// Чистка ников старых аккаунтов (tasks/T-0150): чистая часть команды
// `names:clean` — что и как менять. Проход по базе пачками проверен на живом
// Postgres в account-name.integration.test.ts.

const ID = "a1b2c3d4-0000-4000-8000-000000000000";
const OTHER_ID = "00000000-0000-4000-8000-000000000001";

function row(patch: Partial<CleanupRow> = {}): CleanupRow {
  return { accountId: ID, displayName: "Оленька", username: null, platformName: "Оленька", nameLockedAt: null, ...patch };
}

describe("planCleanup: что менять", () => {
  it("чистый ник — в обновлениях его нет", () => {
    const plan = planCleanup([row()]);
    expect(plan.updates).toEqual([]);
    expect(plan.byVerdict.ok).toBe(1);
  });

  it("чистый ник без исходника не трогается: исходник заполнит следующий вход", () => {
    const plan = planCleanup([row({ platformName: null })]);
    expect(plan.updates).toEqual([]);
    expect(plan.byVerdict.ok).toBe(1);
  });

  it("ник с матом заменяется на «Игрок NNNN», исходник сохраняется", () => {
    const plan = planCleanup([row({ displayName: "хуй", platformName: "хуй" })]);
    expect(plan.byVerdict.profanity).toBe(1);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toEqual({ accountId: ID, displayName: displayNameFor("хуй", null, ID).name, platformName: "хуй" });
    expect(plan.updates[0]?.displayName).toMatch(/^Игрок \d{4}$/);
  });

  it("ник с матом при чистом username — берётся username", () => {
    const plan = planCleanup([row({ displayName: "хуй", platformName: "хуй", username: "tolik" })]);
    expect(plan.updates).toEqual([{ accountId: ID, displayName: "tolik", platformName: "хуй" }]);
  });

  it("ник из декоративных знаков чистится, счётчик — symbols", () => {
    const plan = planCleanup([row({ displayName: "Оля ҉҉҉", platformName: "Оля ҉҉҉" })]);
    expect(plan.byVerdict.symbols).toBe(1);
    expect(plan.updates).toEqual([{ accountId: ID, displayName: "Оля", platformName: "Оля ҉҉҉" }]);
  });

  it("ни одной буквы — «empty», запасное имя по username", () => {
    const plan = planCleanup([row({ displayName: "҉ ҉҉", platformName: "҉ ҉҉", username: "tolik" })]);
    expect(plan.byVerdict.empty).toBe(1);
    expect(plan.updates[0]?.displayName).toBe("tolik");
  });

  it("длинный ник обрезается, счётчик — trimmed", () => {
    const long = "Абвгде".repeat(6);
    const plan = planCleanup([row({ displayName: long, platformName: long })]);
    expect(plan.byVerdict.trimmed).toBe(1);
    expect(plan.updates[0]?.displayName.endsWith("…")).toBe(true);
    expect(plan.updates[0]?.platformName).toBe(long);
  });
});

describe("planCleanup: закреплённые и исходник", () => {
  it("закреплённый ник пропущен и в счётчики вердиктов не входит", () => {
    const plan = planCleanup([row({ displayName: "хуй", platformName: "хуй", nameLockedAt: new Date("2026-10-15T10:00:00Z") })]);
    expect(plan.updates).toEqual([]);
    expect(Object.values(plan.byVerdict).reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(plan.locked).toBe(1);
  });

  it("исходник пуст — чистится нынешний ник и копируется в исходник", () => {
    const plan = planCleanup([row({ displayName: "Оля ҉҉҉", platformName: null })]);
    expect(plan.updates).toEqual([{ accountId: ID, displayName: "Оля", platformName: "Оля ҉҉҉" }]);
  });

  it("исходник есть — чистится он, и перезаписывать его незачем", () => {
    // Ник в базе не совпадает с чисткой исходника (правила чистки с тех пор менялись).
    const plan = planCleanup([row({ displayName: "Оля ҉", platformName: "Оля ҉҉҉҉" })]);
    expect(plan.updates).toEqual([{ accountId: ID, displayName: "Оля", platformName: "Оля ҉҉҉҉" }]);
  });

  it("ник совпадает с чисткой исходника — обновления нет, даже если исходник грязный", () => {
    const plan = planCleanup([row({ displayName: "Оля", platformName: "Оля ҉҉҉" })]);
    expect(plan.updates).toEqual([]);
    expect(plan.byVerdict.symbols).toBe(1);
  });
});

describe("planCleanup: сводка", () => {
  it("счётчики по всем вердиктам, нули на месте", () => {
    const plan = planCleanup([
      row({ accountId: ID }),
      row({ accountId: OTHER_ID, displayName: "хуй", platformName: "хуй" }),
      row({ accountId: "00000000-0000-4000-8000-000000000002", displayName: "Вася ҉", platformName: "Вася ҉" }),
    ]);
    expect(plan.byVerdict).toEqual({ ok: 1, trimmed: 0, symbols: 1, empty: 0, profanity: 1 });
    expect(plan.updates.map((update) => update.accountId)).toEqual([OTHER_ID, "00000000-0000-4000-8000-000000000002"]);
  });

  it("пустая пачка — нули и пустой список", () => {
    expect(planCleanup([])).toEqual({ updates: [], byVerdict: { ok: 0, trimmed: 0, symbols: 0, empty: 0, profanity: 0 }, locked: 0 });
  });

  it("повторный проход по уже очищенным строкам ничего не меняет", () => {
    const rows = [
      row({ accountId: ID, displayName: "Оля ҉҉҉", platformName: null }),
      row({ accountId: OTHER_ID, displayName: "хуй", platformName: "хуй" }),
    ];
    const cleaned = rows.map((source) => {
      const update = planCleanup([source]).updates[0];
      return update === undefined ? source : { ...source, displayName: update.displayName, platformName: update.platformName };
    });
    expect(planCleanup(cleaned).updates).toEqual([]);
  });
});

describe("parseCleanArgs", () => {
  it("без флагов — настоящая чистка", () => {
    expect(parseCleanArgs([])).toEqual({ dryRun: false });
  });

  it("--dry-run — только счётчики", () => {
    expect(parseCleanArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  it("незнакомый флаг — ошибка, а не молчаливая чистка", () => {
    expect(() => parseCleanArgs(["--dry"])).toThrow(/--dry-run/);
    expect(() => parseCleanArgs(["--dry-run", "лишнее"])).toThrow();
  });
});

describe("planCleanup: правила фильтра имён (T-0338)", () => {
  const rules = compileNameRules([{ ruleId: "00000000-0000-4000-8000-000000000001", category: "brand", kind: "exact", pattern: "пример-бренд" }]);

  it("без набора ник с брендом не трогается, с набором — режется, исходник сохраняется", () => {
    const source = row({ displayName: "Вася пример-бренд", platformName: "Вася пример-бренд" });
    expect(planCleanup([source]).updates).toEqual([]);

    const plan = planCleanup([source], rules);
    expect(plan.updates).toEqual([{ accountId: ID, displayName: "Вася", platformName: "Вася пример-бренд" }]);
    expect(plan.byVerdict.symbols).toBe(1);
  });

  it("запасной ход (username) чистится теми же правилами", () => {
    const plan = planCleanup([row({ displayName: "пример-бренд", platformName: "пример-бренд", username: "пример-бренд" })], rules);
    expect(plan.updates[0]?.displayName).toMatch(/^Игрок \d{4}$/u);
  });
});

describe("cleanAll: набор правил и крючки onPage и shouldStop (T-0338)", () => {
  const rules = compileNameRules([{ ruleId: "00000000-0000-4000-8000-000000000001", category: "brand", kind: "exact", pattern: "пример-бренд" }]);
  const TOTAL = 501;

  /** Таблица аккаунтов в памяти ровно настолько, насколько её трогает проход пачками. */
  function fakePrisma() {
    const rows: CleanupRow[] = Array.from({ length: TOTAL }, (_, index) => ({
      accountId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      displayName: "Вася пример-бренд",
      username: null,
      platformName: "Вася пример-бренд",
      nameLockedAt: null,
    }));
    const reads: (string | null)[] = [];
    const prisma = {
      account: {
        findMany: async (args: { where: { accountId?: { gt: string } }; take: number }) => {
          const cursor = args.where.accountId?.gt ?? null;
          reads.push(cursor);
          return rows.filter((item) => cursor === null || item.accountId > cursor).slice(0, args.take);
        },
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (writes: Promise<{ count: number }>[]) => await Promise.all(writes),
    } as unknown as PrismaClient;
    return { prisma, reads };
  }

  it("набор правил доходит до чистки пачек; без набора бренд остаётся", async () => {
    const result = await cleanAll(fakePrisma().prisma, { dryRun: false }, {}, rules);
    expect(result).toMatchObject({ scanned: TOTAL, planned: TOTAL, updated: TOTAL });
    expect((await cleanAll(fakePrisma().prisma, { dryRun: false })).planned).toBe(0);
  });

  it("onPage вызывается после каждой пачки с растущими итогами", async () => {
    const { prisma } = fakePrisma();
    const progress: CleanResult[] = [];

    await cleanAll(prisma, { dryRun: false }, { onPage: async (state) => void progress.push({ ...state }) }, rules);

    expect(progress.map((state) => state.scanned)).toEqual([500, 501]);
    expect(progress.map((state) => state.updated)).toEqual([500, 501]);
  });

  it("shouldStop, вернувший true после первой пачки, останавливает проход: вторая пачка не читается", async () => {
    const { prisma, reads } = fakePrisma();
    let asked = 0;

    const result = await cleanAll(prisma, { dryRun: false }, { shouldStop: async () => ++asked > 1 }, rules);

    expect(reads).toHaveLength(1);
    expect(asked).toBe(2);
    expect(result.scanned).toBe(500);
  });
});
