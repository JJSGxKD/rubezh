import { describe, expect, it } from "vitest";
import { parseCleanArgs, planCleanup, type CleanupRow } from "../src/cli/display-names-clean.js";
import { displayNameFor } from "../src/modules/auth/display-name.js";

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
