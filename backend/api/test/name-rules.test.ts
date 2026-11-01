import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { ForbiddenError } from "../src/common/domain-error.js";
import { NAME_RULE_LIMITS } from "../src/modules/name-rules/name-rules-limits.js";
import { NameRuleConflictError, NameRuleInvalidError, NameRuleNotFoundError } from "../src/modules/name-rules/name-rules-errors.js";
import type { NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import type { NameRulesRepository, StoredNameRule } from "../src/modules/name-rules/name-rules.repository.js";
import { NameRulesService } from "../src/modules/name-rules/name-rules.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Сервис правил фильтра имён (tasks/T-0338): права, проверки, аудит,
 * рассылка изменения и проверка на примерах без записи. Слова нейтральные.
 */

const OWNER_ID = "777000333";

class MemoryNameRules implements NameRulesRepository {
  rows = new Map<string, StoredNameRule>();
  touched = 0;
  private clock = 0;

  async list(): Promise<StoredNameRule[]> {
    this.touched += 1;
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async listActive(): Promise<StoredNameRule[]> {
    this.touched += 1;
    return [...this.rows.values()].filter((row) => row.active).map((row) => ({ ...row }));
  }

  async findByKey(category: string, kind: string, pattern: string): Promise<StoredNameRule | null> {
    this.touched += 1;
    return [...this.rows.values()].find((row) => row.category === category && row.kind === kind && row.pattern === pattern) ?? null;
  }

  async count(): Promise<number> {
    this.touched += 1;
    return this.rows.size;
  }

  async countRegex(): Promise<number> {
    this.touched += 1;
    return [...this.rows.values()].filter((row) => row.active && row.kind === "regex").length;
  }

  async insert(row: StoredNameRule): Promise<void> {
    this.touched += 1;
    this.rows.set(row.ruleId, { ...row });
  }

  async update(ruleId: string, patch: Partial<Pick<StoredNameRule, "category" | "kind" | "pattern" | "active" | "note">>, at: Date, by: string | null): Promise<StoredNameRule | null> {
    this.touched += 1;
    const row = this.rows.get(ruleId);
    if (row === undefined) return null;
    const next = { ...row, ...patch, updatedAt: at, updatedBy: by };
    this.rows.set(ruleId, next);
    return { ...next };
  }

  async remove(ruleId: string): Promise<boolean> {
    this.touched += 1;
    return this.rows.delete(ruleId);
  }

  seed(patch: Partial<StoredNameRule> & { pattern: string }): StoredNameRule {
    this.clock += 1;
    const row: StoredNameRule = {
      ruleId: `00000000-0000-4000-8000-${String(this.clock).padStart(12, "0")}`,
      category: "brand",
      kind: "exact",
      active: true,
      note: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      updatedBy: null,
      ...patch,
    };
    this.rows.set(row.ruleId, row);
    return row;
  }
}

function setup() {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const repository = new MemoryNameRules();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const published: string[] = [];
  const cache = {
    publishChanged: async (ruleId: string) => {
      if (cache.fail) throw new Error("redis down");
      published.push(ruleId);
    },
    fail: false,
  };
  const service = new NameRulesService(repository, cache as unknown as NameRulesCache, new RolesService(config, roles, accounts));
  return { repository, roles, accounts, cache, published, service };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role?: "admin" | "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

const brand = (pattern: string, extra: Record<string, unknown> = {}) => ({ category: "brand" as const, kind: "exact" as const, pattern, ...extra });

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("права", () => {
  it("каждый метод требует names.edit: игрок и геймдизайнер получают отказ, хранилище не тронуто", async () => {
    const ctx = setup();
    const stranger = await person(ctx, "801");
    const designer = await person(ctx, "802", "game_designer");
    const rule = ctx.repository.seed({ pattern: "пример-бренд" });
    ctx.repository.touched = 0;

    for (const actor of [stranger, designer]) {
      await expect(ctx.service.view(actor)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(ctx.service.create(actor, brand("пример"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(ctx.service.update(actor, rule.ruleId, { active: false })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(ctx.service.remove(actor, rule.ruleId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(ctx.service.probe(actor, { ...brand("пример"), samples: ["Вася"] })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(ctx.repository.touched).toBe(0);
    expect(ctx.roles.entries).toHaveLength(0);
  });

  it("модератор и администратор правят правила", async () => {
    const ctx = setup();
    for (const [id, role] of [["803", "moderator"], ["804", "admin"]] as const) {
      const actor = await person(ctx, id, role);
      await expect(ctx.service.create(actor, brand(`пример-${id}`))).resolves.toMatchObject({ pattern: `пример-${id}` });
    }
  });
});

describe("view", () => {
  it("правила с датой ISO и пределы для экрана", async () => {
    const ctx = setup();
    const admin = await person(ctx, "805", "admin");
    ctx.repository.seed({ pattern: "пример-бренд", note: "заметка", updatedAt: new Date("2026-10-27T10:00:00Z"), updatedBy: admin.accountId });

    const view = await ctx.service.view(admin);

    expect(view.rules).toEqual([{ ruleId: expect.any(String), category: "brand", kind: "exact", pattern: "пример-бренд", active: true, note: "заметка", updatedAt: "2026-10-27T10:00:00.000Z", updatedBy: admin.accountId }]);
    expect(view.limits).toEqual({ patternMax: 100, noteMax: 200, rulesMax: 2000, regexRulesMax: 100, samplesMax: 20, sampleMax: 256 });
  });
});

describe("create", () => {
  it("успех: запись, аудит с after, рассылка, лог без шаблона", async () => {
    const ctx = setup();
    const admin = await person(ctx, "806", "admin");

    const created = await ctx.service.create(admin, brand("  пример-бренд  ", { note: "чужой бренд" }));

    expect(created).toMatchObject({ category: "brand", kind: "exact", pattern: "пример-бренд", active: true, note: "чужой бренд", updatedBy: admin.accountId });
    expect(ctx.repository.rows.get(created.ruleId)?.pattern).toBe("пример-бренд");
    expect(ctx.roles.entries).toEqual([expect.objectContaining({ action: "names.rule.create", target: created.ruleId, actorAccountId: admin.accountId, after: created })]);
    expect(ctx.published).toEqual([created.ruleId]);
    const line = logs.find((entry) => entry.includes("name_rule_created"));
    expect(line).toContain(created.ruleId);
    expect(logs.join("\n")).not.toContain("пример-бренд");
  });

  it("неизвестные категория и вид, пустой и длинный шаблон — NameRuleInvalidError с русским текстом", async () => {
    const ctx = setup();
    const admin = await person(ctx, "807", "admin");
    const invalid = async (input: unknown, text: RegExp) => {
      const error = await ctx.service.create(admin, input as never).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(input)).toBeInstanceOf(NameRuleInvalidError);
      expect((error as NameRuleInvalidError).message).toMatch(text);
      expect((error as NameRuleInvalidError).status).toBe(400);
      expect((error as NameRuleInvalidError).code).toBe("name_rule_invalid");
    };
    await invalid({ category: "spam", kind: "exact", pattern: "x" }, /[а-я]/u);
    await invalid({ category: "brand", kind: "glob", pattern: "x" }, /[а-я]/u);
    await invalid(brand(""), /[а-я]/u);
    await invalid(brand("   "), /[а-я]/u);
    await invalid(brand("а".repeat(101)), /[а-я]/u);
    await invalid(brand("пример", { note: "н".repeat(201) }), /[а-я]/u);
    await invalid({ category: "ads", kind: "regex", pattern: "(a+)+" }, /Повтор группы/u);
    await invalid({ category: "ads", kind: "regex", pattern: "a*" }, /пустой строкой/u);
    expect(ctx.repository.rows.size).toBe(0);
    expect(ctx.roles.entries).toHaveLength(0);
    expect(ctx.published).toEqual([]);
  });

  it("регулярка, прошедшая разбор, но медленная на злых строках, не сохраняется", async () => {
    const ctx = setup();
    const admin = await person(ctx, "808", "admin");
    // Три повтора без предела разбор пропускает, а на длинной строке «aaaa…!» они ползут.
    await expect(ctx.service.create(admin, { category: "ads", kind: "regex", pattern: "a*a*a*b" })).rejects.toThrow(/слишком медленный/u);
    expect(ctx.repository.rows.size).toBe(0);
  }, 5_000);

  it("дубль — в другом регистре и с «ё»/«е» — NameRuleConflictError; та же фраза в другой категории или виде — не дубль", async () => {
    const ctx = setup();
    const admin = await person(ctx, "809", "admin");
    await ctx.service.create(admin, brand("Ёлка Шоп"));

    const error = await ctx.service.create(admin, brand("ЕЛКА шоп")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NameRuleConflictError);
    expect((error as NameRuleConflictError).status).toBe(409);
    expect((error as NameRuleConflictError).message).toBe("Такое правило уже есть");

    await expect(ctx.service.create(admin, { category: "ads", kind: "exact", pattern: "Ёлка Шоп" })).resolves.toBeDefined();
    await expect(ctx.service.create(admin, { category: "brand", kind: "word", pattern: "Ёлка Шоп" })).resolves.toBeDefined();
  });

  it("у регулярки сравнение буквальное: «ёлка» и «елка» — разные правила", async () => {
    const ctx = setup();
    const admin = await person(ctx, "810", "admin");
    await ctx.service.create(admin, { category: "other", kind: "regex", pattern: "ёлка" });
    await expect(ctx.service.create(admin, { category: "other", kind: "regex", pattern: "елка" })).resolves.toBeDefined();
    await expect(ctx.service.create(admin, { category: "other", kind: "regex", pattern: "ёлка" })).rejects.toBeInstanceOf(NameRuleConflictError);
  });

  it("2001-е правило — конфликт «Правил уже 2000»", async () => {
    const ctx = setup();
    const admin = await person(ctx, "811", "admin");
    for (let index = 0; index < NAME_RULE_LIMITS.rulesMax; index += 1) ctx.repository.seed({ pattern: `пример-${String(index)}` });

    const error = await ctx.service.create(admin, brand("ещё-один")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NameRuleConflictError);
    expect((error as NameRuleConflictError).message).toBe("Правил уже 2000 — нужно удалить лишние");
  });

  it("сотая регулярка создаётся, сто первая — конфликт; точные правила идут до общего потолка", async () => {
    const ctx = setup();
    const admin = await person(ctx, "813", "admin");
    for (let index = 0; index < NAME_RULE_LIMITS.regexRulesMax - 1; index += 1) ctx.repository.seed({ kind: "regex", pattern: `пример${String(index)}` });

    await expect(ctx.service.create(admin, { category: "brand", kind: "regex", pattern: "сотая" })).resolves.toMatchObject({ kind: "regex" });
    const error = await ctx.service.create(admin, { category: "brand", kind: "regex", pattern: "сто-первая" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NameRuleConflictError);
    expect((error as NameRuleConflictError).message).toBe("Регулярок уже 100 — нужно удалить лишние");
    await expect(ctx.service.create(admin, brand("точное-правило"))).resolves.toMatchObject({ kind: "exact" });
  });

  it("сбой рассылки не роняет запись и не отменяет аудит", async () => {
    const ctx = setup();
    const admin = await person(ctx, "812", "admin");
    ctx.cache.fail = true;

    const created = await ctx.service.create(admin, brand("пример-бренд"));

    expect(ctx.repository.rows.has(created.ruleId)).toBe(true);
    expect(ctx.roles.entries.map((entry) => entry.action)).toEqual(["names.rule.create"]);
  });
});

describe("update и remove", () => {
  it("update: before и after в аудите, итоговое правило проверяется, рассылка", async () => {
    const ctx = setup();
    const admin = await person(ctx, "813", "admin");
    const created = await ctx.service.create(admin, brand("пример-бренд"));
    ctx.roles.entries.length = 0;
    ctx.published.length = 0;

    const updated = await ctx.service.update(admin, created.ruleId, { active: false, note: "пока не нужно" });

    expect(updated).toMatchObject({ ruleId: created.ruleId, active: false, note: "пока не нужно", pattern: "пример-бренд" });
    expect(ctx.roles.entries).toEqual([expect.objectContaining({ action: "names.rule.update", target: created.ruleId, before: created, after: updated })]);
    expect(ctx.published).toEqual([created.ruleId]);
    expect(logs.join("\n")).not.toContain("пример-бренд");
  });

  it("update: правка точного правила в regex сверх потолка — конфликт; правка регулярки без смены вида проходит", async () => {
    const ctx = setup();
    const admin = await person(ctx, "814", "admin");
    const first = ctx.repository.seed({ kind: "regex", pattern: "пример-первый" });
    for (let index = 1; index < NAME_RULE_LIMITS.regexRulesMax; index += 1) ctx.repository.seed({ kind: "regex", pattern: `пример${String(index)}` });
    const exact = ctx.repository.seed({ pattern: "точное" });

    await expect(ctx.service.update(admin, exact.ruleId, { kind: "regex" })).rejects.toBeInstanceOf(NameRuleConflictError);
    await expect(ctx.service.update(admin, first.ruleId, { pattern: "пример-другой" })).resolves.toMatchObject({ pattern: "пример-другой" });
  });

  it("update: смена вида на regex с опасным шаблоном и дубль с другим правилом отклоняются", async () => {
    const ctx = setup();
    const admin = await person(ctx, "814", "admin");
    const first = await ctx.service.create(admin, brand("(a+)+"));
    await ctx.service.create(admin, brand("пример-два"));
    await expect(ctx.service.update(admin, first.ruleId, { kind: "regex" })).rejects.toBeInstanceOf(NameRuleInvalidError);
    await expect(ctx.service.update(admin, first.ruleId, { pattern: "ПРИМЕР-ДВА" })).rejects.toBeInstanceOf(NameRuleConflictError);
    // Правка правила самого на себя дублем не считается.
    await expect(ctx.service.update(admin, first.ruleId, { note: "тот же шаблон" })).resolves.toMatchObject({ pattern: "(a+)+" });
  });

  it("remove: before в аудите, рассылка; несуществующее правило — 404", async () => {
    const ctx = setup();
    const admin = await person(ctx, "815", "admin");
    const created = await ctx.service.create(admin, brand("пример-бренд"));
    ctx.roles.entries.length = 0;

    await ctx.service.remove(admin, created.ruleId);

    expect(ctx.repository.rows.size).toBe(0);
    expect(ctx.roles.entries).toEqual([expect.objectContaining({ action: "names.rule.delete", target: created.ruleId, before: created })]);
    expect(ctx.published).toEqual([created.ruleId, created.ruleId]);

    const ghost = "00000000-0000-4000-8000-0000000000ff";
    const error = await ctx.service.remove(admin, ghost).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NameRuleNotFoundError);
    expect((error as NameRuleNotFoundError).status).toBe(404);
    await expect(ctx.service.update(admin, ghost, { active: false })).rejects.toBeInstanceOf(NameRuleNotFoundError);
  });
});

describe("probe: проверка на примерах без записи", () => {
  it("кандидат режет образец, образец без совпадения — нет; ничего не пишется и не аудируется", async () => {
    const ctx = setup();
    const admin = await person(ctx, "816", "admin");
    ctx.repository.seed({ pattern: "реклама", category: "ads" });
    ctx.repository.touched = 0;

    const results = await ctx.service.probe(admin, { ...brand("пример-бренд"), samples: ["Вася пример-бренд", "Вася", "Вася реклама"] });

    expect(results).toEqual([
      { sample: "Вася пример-бренд", name: "Вася", verdict: "symbols", candidateHit: true, saved: false },
      { sample: "Вася", name: "Вася", verdict: "ok", candidateHit: false, saved: false },
      { sample: "Вася реклама", name: "Вася", verdict: "symbols", candidateHit: false, saved: false },
    ]);
    expect(ctx.repository.rows.size).toBe(1);
    expect(ctx.roles.entries).toHaveLength(0);
    expect(ctx.published).toEqual([]);
  });

  it("исключение-кандидат показывает, что спасло строку", async () => {
    const ctx = setup();
    const admin = await person(ctx, "817", "admin");
    ctx.repository.seed({ pattern: "пример" });

    const [result] = await ctx.service.probe(admin, { category: "allow", kind: "exact", pattern: "пример-бренд", samples: ["Вася пример-бренд"] });

    expect(result).toMatchObject({ name: "Вася пример-бренд", verdict: "ok", candidateHit: false, saved: true });
  });

  it("при ruleId кандидат заменяет существующее правило: старый шаблон уже не режет", async () => {
    const ctx = setup();
    const admin = await person(ctx, "818", "admin");
    const existing = ctx.repository.seed({ pattern: "пример-бренд" });

    const results = await ctx.service.probe(admin, { ruleId: existing.ruleId, ...brand("другое-слово"), samples: ["Вася пример-бренд", "Вася другое-слово"] });

    expect(results.map((result) => [result.name, result.candidateHit])).toEqual([
      ["Вася пример-бренд", false],
      ["Вася", true],
    ]);
  });

  it("образцы: от 1 до 20, по 256 знаков; опасная регулярка и плохая категория — 400", async () => {
    const ctx = setup();
    const admin = await person(ctx, "819", "admin");
    const base = brand("пример");
    for (const samples of [[], Array.from({ length: 21 }, () => "Вася"), ["а".repeat(257)]]) {
      await expect(ctx.service.probe(admin, { ...base, samples }), String(samples.length)).rejects.toBeInstanceOf(NameRuleInvalidError);
    }
    await expect(ctx.service.probe(admin, { ...base, samples: Array.from({ length: 20 }, () => "а".repeat(256)) })).resolves.toHaveLength(20);
    await expect(ctx.service.probe(admin, { category: "ads", kind: "regex", pattern: "(a+)+", samples: ["Вася"] })).rejects.toBeInstanceOf(NameRuleInvalidError);
    await expect(ctx.service.probe(admin, { category: "spam" as never, kind: "exact", pattern: "x", samples: ["Вася"] })).rejects.toBeInstanceOf(NameRuleInvalidError);
  });
});
