import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { ArticleView, PlaceView } from "../src/modules/ledger/ledger-chart.js";
import type { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { LedgerOperationInvalidError, LedgerOperationTemplateTakenError } from "../src/modules/ledger/operations/operation-errors.js";
import { operationInputSchema, type OperationInput } from "../src/modules/ledger/operations/operation-input.js";
import type { OperationView } from "../src/modules/ledger/operations/operation-view.js";
import type { OperationsService } from "../src/modules/ledger/operations/operations.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { LedgerTemplateArchivedError, LedgerTemplateInvalidError, LedgerTemplateNotFoundError } from "../src/modules/ledger/templates/template-errors.js";
import { createTemplateSchema } from "../src/modules/ledger/templates/template-input.js";
import { draftInput, eventDate, firstDayOf, isDue, monthTitle, periodProblem, type DraftableTemplate } from "../src/modules/ledger/templates/schedule.js";
import type { NewTemplate, StoredTemplate, TemplatePatch, TemplatesRepository } from "../src/modules/ledger/templates/templates.repository.js";
import { TemplatesService } from "../src/modules/ledger/templates/templates.service.js";

/**
 * Шаблоны повторяющихся расходов (Р220, tasks/T-0463; docs/37-accounting.md §8): когда шаблон «наступил»,
 * какой черновик из него выходит и как «Расходы месяца» ведёт себя при повторе, гонке и сбое одного из шаблонов.
 * Правила — чистые функции; сервис — на подставных зависимостях, без базы. Как это ложится на таблицы и
 * уникальный ключ периода, проверяет `ledger-templates.integration.test.ts`.
 */

const NOW = new Date("2026-11-13T10:00:00.000Z");

const vps: DraftableTemplate = { name: "VPS", articleId: "vps", placeAccountId: "bank.karta", amount: 150_000n, currency: "RUB", schedule: "monthly", month: null };
const domains: DraftableTemplate = { name: "Домены", articleId: "domains", placeAccountId: "bank.karta", amount: 320_000n, currency: "RUB", schedule: "yearly", month: 3 };

describe("isDue: наступил ли шаблон в периоде", () => {
  it("monthly — в любом месяце", () => {
    for (const period of ["2026-01", "2026-03", "2026-11", "2026-12"]) expect(isDue(vps, period)).toBe(true);
  });

  it("yearly — только в своём месяце года, в любой год", () => {
    expect(isDue(domains, "2026-03")).toBe(true);
    expect(isDue(domains, "2027-03")).toBe(true);
    expect(isDue(domains, "2026-02")).toBe(false);
    expect(isDue(domains, "2026-04")).toBe(false);
    expect(isDue(domains, "2026-11")).toBe(false);
  });

  it("yearly без месяца не наступает никогда: схема базы такого не пустит, но правило не гадает", () => {
    expect(isDue({ schedule: "yearly", month: null }, "2026-03")).toBe(false);
  });
});

describe("draftInput: вход операции расхода из шаблона", () => {
  it("сумма в единицах валюты места, место, статья, дата — первое число периода", () => {
    expect(draftInput(vps, "2026-11")).toEqual({
      kind: "expense",
      from: "bank.karta",
      article: "vps",
      amount: "1500.00",
      at: "2026-11-01",
      note: "VPS за ноябрь 2026",
    });
  });

  it("месяц в тексте — по-русски, год — из периода", () => {
    expect(draftInput(domains, "2027-03").note).toBe("Домены за март 2027");
    expect(monthTitle("2026-01")).toBe("январь 2026");
    expect(monthTitle("2026-12")).toBe("декабрь 2026");
  });

  it("у валюты без дробной части — целая сумма, у криптовалюты — со своими знаками", () => {
    expect(draftInput({ ...vps, currency: "XTR", amount: 500n }, "2026-11").amount).toBe("500");
    expect(draftInput({ ...vps, currency: "GRAM", amount: 1_500_000_000n }, "2026-11").amount).toBe("1.500000000");
  });

  it("то, что выходит, проходит схему ручных операций: сервер не отправит в операции того, что те не примут", () => {
    for (const period of ["2026-01", "2026-09", "2026-12"]) {
      for (const template of [vps, domains, { ...vps, name: "а" }, { ...vps, name: "ё".repeat(128) }]) {
        expect(operationInputSchema.safeParse(draftInput(template, period)).success).toBe(true);
      }
    }
  });

  it("первое число периода и дата события: будущее число заменяется сегодняшним, прошлое остаётся", () => {
    expect(firstDayOf("2026-12")).toBe("2026-12-01");
    expect(eventDate("2026-10", NOW)).toBe("2026-10-01");
    expect(eventDate("2026-11", NOW)).toBe("2026-11-01");
    expect(eventDate("2026-12", NOW)).toBe("2026-11-13");
  });
});

describe("periodProblem: окно периода — от прошлого месяца до следующего", () => {
  it("прошлый, нынешний и следующий месяцы — можно", () => {
    expect(periodProblem("2026-10", NOW)).toBeNull();
    expect(periodProblem("2026-11", NOW)).toBeNull();
    expect(periodProblem("2026-12", NOW)).toBeNull();
  });

  it("раньше и позже — отказ с причиной", () => {
    expect(periodProblem("2026-09", NOW)).toMatch(/прошл/u);
    expect(periodProblem("2027-01", NOW)).toMatch(/следующ/u);
  });

  it("граница года: в январе окно — декабрь, январь, февраль", () => {
    const january = new Date("2027-01-05T00:00:00.000Z");
    expect(periodProblem("2026-12", january)).toBeNull();
    expect(periodProblem("2027-02", january)).toBeNull();
    expect(periodProblem("2026-11", january)).not.toBeNull();
    expect(periodProblem("2027-03", january)).not.toBeNull();
  });

  it("не «ГГГГ-ММ» — отказ: тринадцатого месяца и «2026-1» нет", () => {
    for (const period of ["2026-13", "2026-00", "2026-1", "26-11", "ноябрь", "2026-11-01", ""]) expect(periodProblem(period, NOW)).not.toBeNull();
  });
});

describe("схема шаблона на входе", () => {
  const body = { name: "VPS", articleId: "vps", placeAccountId: "bank.karta", amount: "1500", schedule: "monthly" };

  it("минимальное тело проходит, лишнее поле — опечатка клиента, а не повод его проигнорировать", () => {
    expect(createTemplateSchema.safeParse(body).success).toBe(true);
    expect(createTemplateSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it("сумма — десятичная строка без знака и экспоненты; расписание — из двух; месяц — целое", () => {
    for (const amount of ["-5", "1e3", "", "1,5", 1500]) expect(createTemplateSchema.safeParse({ ...body, amount }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ ...body, schedule: "weekly" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ ...body, schedule: "yearly", month: 3.5 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Сервис на подставных зависимостях

const actor = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram" as const, platformUserId: "1" };

function place(overrides: Partial<PlaceView> = {}): PlaceView {
  return {
    placeId: "bank.karta",
    name: "Карта",
    currency: "RUB",
    archived: false,
    balance: "0.00",
    fee: null,
    accounts: [{ accountId: "bank.karta", name: "Карта", balance: "0.00" }],
    ...overrides,
  };
}

function article(overrides: Partial<ArticleView> = {}): ArticleView {
  return { articleId: "vps", kind: "expense", name: "VPS", system: false, archived: false, ...overrides };
}

class MemoryTemplates implements TemplatesRepository {
  readonly rows = new Map<string, StoredTemplate>();
  /** Периоды, на которые уже есть операции: «шаблон|период». */
  readonly drafted = new Set<string>();

  async list(): Promise<StoredTemplate[]> {
    return [...this.rows.values()];
  }

  async byId(templateId: string): Promise<StoredTemplate | null> {
    return this.rows.get(templateId) ?? null;
  }

  async insert(template: NewTemplate): Promise<boolean> {
    if (this.rows.has(template.templateId)) return false;
    this.rows.set(template.templateId, { ...template, archivedAt: null, createdAt: new Date(NOW) });
    return true;
  }

  async update(templateId: string, patch: TemplatePatch): Promise<boolean> {
    const row = this.rows.get(templateId);
    if (row === undefined || row.archivedAt !== null) return false;
    this.rows.set(templateId, { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
    return true;
  }

  async archive(templateId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(templateId);
    if (row === undefined || row.archivedAt !== null) return false;
    this.rows.set(templateId, { ...row, archivedAt: at });
    return true;
  }

  async draftedTemplateIds(period: string): Promise<Set<string>> {
    return new Set([...this.drafted].filter((key) => key.endsWith(`|${period}`)).map((key) => key.split("|")[0] ?? ""));
  }
}

interface Rig {
  service: TemplatesService;
  repository: MemoryTemplates;
  audit: AuditEntry[];
  created: { input: OperationInput; template: { templateId: string; period: string } | undefined }[];
  /** Проведение операции: шаблон звать его не должен никогда. */
  submit: ReturnType<typeof vi.fn>;
  setCreate(handler: (input: OperationInput, template: { templateId: string; period: string } | undefined) => Promise<void>): void;
}

function rig(places: PlaceView[] = [place()], articles: ArticleView[] = [article(), article({ articleId: "domains", name: "Домены" }), article({ articleId: "cdn", name: "CDN" })]): Rig {
  const repository = new MemoryTemplates();
  const audit: AuditEntry[] = [];
  const created: Rig["created"] = [];
  let handler: (input: OperationInput, template: { templateId: string; period: string } | undefined) => Promise<void> = async () => undefined;
  const submit = vi.fn();
  const operations = {
    submit,
    create: async (_actor: unknown, input: OperationInput, template?: { templateId: string; period: string }) => {
      await handler(input, template);
      created.push({ input, template });
      if (template !== undefined) repository.drafted.add(`${template.templateId}|${template.period}`);
      return { operationId: "op" } as unknown as OperationView;
    },
  } as unknown as OperationsService;
  const chart = { places: async () => places, articles: async () => articles } as unknown as LedgerChartService;
  const roles = { audit: async (entry: AuditEntry) => void audit.push(entry) } as unknown as RolesService;
  return {
    service: new TemplatesService(repository, operations, chart, roles),
    repository,
    audit,
    created,
    submit,
    setCreate: (next) => {
      handler = next;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

const vpsBody = { name: "VPS", articleId: "vps", placeAccountId: "bank.karta", amount: "1500.00", schedule: "monthly" as const };
const domainsBody = { name: "Домены", articleId: "domains", placeAccountId: "bank.karta", amount: "3200", schedule: "yearly" as const, month: 3 };

describe("шаблоны: заведение", () => {
  it("идентификатор — из названия, сумма хранится в минимальных единицах, ответ — в единицах валюты места, аудит записан", async () => {
    const { service, repository, audit } = rig();
    const view = await service.create(actor, vpsBody);
    expect(view).toMatchObject({ templateId: "vps", name: "VPS", articleId: "vps", placeAccountId: "bank.karta", currency: "RUB", amount: "1500.00", schedule: "monthly", month: null, archived: false });
    expect((await repository.byId("vps"))?.amount).toBe(150_000n);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorAccountId: actor.accountId, action: "ledger.template.create", target: "vps" });
  });

  it("то же название — следующий идентификатор с суффиксом", async () => {
    const { service } = rig();
    await service.create(actor, vpsBody);
    expect((await service.create(actor, vpsBody)).templateId).toBe("vps-2");
  });

  it("нельзя: статья-поступление, архивная статья, неизвестная статья", async () => {
    const income = rig([place()], [article({ kind: "income" })]);
    expect(await failure(income.service.create(actor, vpsBody))).toBeInstanceOf(LedgerTemplateInvalidError);
    const archived = rig([place()], [article({ archived: true })]);
    expect(await failure(archived.service.create(actor, vpsBody))).toBeInstanceOf(LedgerTemplateInvalidError);
    const unknown = rig([place()], []);
    expect(await failure(unknown.service.create(actor, vpsBody))).toBeInstanceOf(LedgerTemplateInvalidError);
  });

  it("нельзя: неизвестное и архивное место", async () => {
    expect(await failure(rig([]).service.create(actor, vpsBody))).toBeInstanceOf(LedgerTemplateInvalidError);
    expect(await failure(rig([place({ archived: true })]).service.create(actor, vpsBody))).toBeInstanceOf(LedgerTemplateInvalidError);
  });

  it("нельзя: нулевая сумма, лишние знаки после запятой, годовой без месяца, месячный с месяцем, месяц вне 1…12", async () => {
    const { service, repository } = rig();
    for (const body of [
      { ...vpsBody, amount: "0" },
      { ...vpsBody, amount: "1.005" },
      { ...domainsBody, month: undefined },
      { ...vpsBody, month: 3 },
      { ...domainsBody, month: 13 },
      { ...domainsBody, month: 0 },
    ]) {
      expect(await failure(service.create(actor, body))).toBeInstanceOf(LedgerTemplateInvalidError);
    }
    expect(await repository.list()).toHaveLength(0);
  });
});

describe("шаблоны: правка и архив", () => {
  it("правка меняет поля и пишет аудит; смена места на другую валюту без суммы — отказ", async () => {
    const { service, audit } = rig([place(), place({ placeId: "stars.bot", currency: "XTR", accounts: [{ accountId: "stars.bot", name: "Звёзды", balance: "0" }] })]);
    await service.create(actor, vpsBody);
    expect((await service.update(actor, "vps", { amount: "1600" })).amount).toBe("1600.00");
    expect(audit.at(-1)).toMatchObject({ action: "ledger.template.update", target: "vps" });
    expect(await failure(service.update(actor, "vps", { placeAccountId: "stars.bot" }))).toBeInstanceOf(LedgerTemplateInvalidError);
    expect((await service.update(actor, "vps", { placeAccountId: "stars.bot", amount: "500" })).currency).toBe("XTR");
  });

  it("месячный шаблон можно сделать годовым вместе с месяцем, а годовой — месячным со сбросом месяца", async () => {
    const { service } = rig();
    await service.create(actor, vpsBody);
    expect(await service.update(actor, "vps", { schedule: "yearly", month: 5 })).toMatchObject({ schedule: "yearly", month: 5 });
    expect(await service.update(actor, "vps", { schedule: "monthly" })).toMatchObject({ schedule: "monthly", month: null });
    expect(await failure(service.update(actor, "vps", { schedule: "yearly" }))).toBeInstanceOf(LedgerTemplateInvalidError);
  });

  it("правка неизвестного — 404, архивного — 409; пустая правка — отказ", async () => {
    const { service } = rig();
    expect(await failure(service.update(actor, "net-takogo", { amount: "1" }))).toBeInstanceOf(LedgerTemplateNotFoundError);
    await service.create(actor, vpsBody);
    expect(await failure(service.update(actor, "vps", {}))).toBeInstanceOf(LedgerTemplateInvalidError);
    await service.archive(actor, "vps");
    expect(await failure(service.update(actor, "vps", { amount: "1" }))).toBeInstanceOf(LedgerTemplateArchivedError);
  });

  it("архив: аудит один, повтор — не ошибка и не второй аудит, неизвестный — 404", async () => {
    const { service, audit } = rig();
    await service.create(actor, vpsBody);
    await service.archive(actor, "vps");
    await service.archive(actor, "vps");
    expect(audit.filter((entry) => entry.action === "ledger.template.archive")).toHaveLength(1);
    expect(await failure(service.archive(actor, "net-takogo"))).toBeInstanceOf(LedgerTemplateNotFoundError);
  });

  it("список — с названием статьи и места; архивные помечены", async () => {
    const { service } = rig();
    await service.create(actor, vpsBody);
    await service.create(actor, domainsBody);
    await service.archive(actor, "domeny");
    const list = await service.list();
    expect(list.map((view) => [view.templateId, view.archived, view.articleName, view.placeName])).toEqual([
      ["vps", false, "VPS", "Карта"],
      ["domeny", true, "Домены", "Карта"],
    ]);
  });
});

describe("«Расходы месяца»: черновики на период", () => {
  it("в ноябре — один черновик (VPS), в марте — два; шаблон ссылается на себя и период, текст — с месяцем", async () => {
    const { service, created } = rig();
    await service.create(actor, vpsBody);
    await service.create(actor, domainsBody);

    expect(await service.draftPeriod(actor, "2026-11", NOW)).toEqual({ period: "2026-11", created: 1, existing: 0, failed: [] });
    expect(created).toHaveLength(1);
    expect(created[0]?.template).toEqual({ templateId: "vps", period: "2026-11" });
    expect(created[0]?.input).toMatchObject({ kind: "expense", from: "bank.karta", article: "vps", amount: "1500.00", at: "2026-11-01", note: "VPS за ноябрь 2026" });

    const march = new Date("2027-03-10T00:00:00.000Z");
    expect(await service.draftPeriod(actor, "2027-03", march)).toMatchObject({ created: 2, existing: 0 });
  });

  it("повтор того же периода — «создано 0, уже было 1», новых операций нет", async () => {
    const { service, created } = rig();
    await service.create(actor, vpsBody);
    await service.draftPeriod(actor, "2026-11", NOW);
    expect(await service.draftPeriod(actor, "2026-11", NOW)).toEqual({ period: "2026-11", created: 0, existing: 1, failed: [] });
    expect(created).toHaveLength(1);
  });

  it("архивный шаблон черновика не даёт", async () => {
    const { service, created } = rig();
    await service.create(actor, vpsBody);
    await service.archive(actor, "vps");
    expect(await service.draftPeriod(actor, "2026-11", NOW)).toMatchObject({ created: 0, existing: 0 });
    expect(created).toHaveLength(0);
  });

  it("гонка: операции ответили «на период уже есть черновик» — это «уже было», а не сбой", async () => {
    const { service, setCreate } = rig();
    await service.create(actor, vpsBody);
    setCreate(async (_input, template) => {
      throw new LedgerOperationTemplateTakenError(template?.templateId ?? "", template?.period ?? "");
    });
    expect(await service.draftPeriod(actor, "2026-11", NOW)).toEqual({ period: "2026-11", created: 0, existing: 1, failed: [] });
  });

  it("сбой одного шаблона не мешает остальным: он назван в ответе с причиной, остальные созданы", async () => {
    const { service, setCreate, created } = rig();
    await service.create(actor, vpsBody);
    await service.create(actor, { ...vpsBody, name: "CDN", articleId: "cdn" });
    setCreate(async (input) => {
      if (input.kind === "expense" && input.article === "cdn") throw new LedgerOperationInvalidError("Статья «cdn» в архиве");
    });
    const result = await service.draftPeriod(actor, "2026-11", NOW);
    expect(result).toMatchObject({ created: 1, existing: 0 });
    expect(result.failed).toEqual([{ templateId: "cdn", name: "CDN", reason: "Статья «cdn» в архиве" }]);
    expect(created.map((entry) => entry.template?.templateId)).toEqual(["vps"]);
  });

  it("не доменная ошибка (сбой базы) — не прячется в ответе, а идёт наверх", async () => {
    const { service, setCreate } = rig();
    await service.create(actor, vpsBody);
    setCreate(async () => {
      throw new Error("соединение потеряно");
    });
    await expect(service.draftPeriod(actor, "2026-11", NOW)).rejects.toThrow("соединение потеряно");
  });

  it("период вне окна или не в формате — 400, ничего не создано и в аудит не попало", async () => {
    const { service, created, audit } = rig();
    await service.create(actor, vpsBody);
    const before = audit.length;
    for (const period of ["2026-09", "2027-01", "2026-13", "ноябрь"]) {
      const error = await failure(service.draftPeriod(actor, period, NOW));
      expect(error).toBeInstanceOf(LedgerTemplateInvalidError);
      expect(error.status).toBe(400);
    }
    expect(created).toHaveLength(0);
    expect(audit).toHaveLength(before);
  });

  it("следующий месяц: событие ещё не случилось, поэтому дата черновика — сегодня, а не будущее первое число", async () => {
    const { service, created } = rig();
    await service.create(actor, vpsBody);
    await service.draftPeriod(actor, "2026-12", NOW);
    expect(created[0]?.input).toMatchObject({ at: "2026-11-13", note: "VPS за декабрь 2026" });
    expect(created[0]?.template).toEqual({ templateId: "vps", period: "2026-12" });
  });

  it("аудит: действие записано, когда что-то создано; пустой повтор журнал не засоряет", async () => {
    const { service, audit } = rig();
    await service.create(actor, vpsBody);
    await service.draftPeriod(actor, "2026-11", NOW);
    expect(audit.filter((entry) => entry.action === "ledger.template.draft_period")).toHaveLength(1);
    await service.draftPeriod(actor, "2026-11", NOW);
    expect(audit.filter((entry) => entry.action === "ledger.template.draft_period")).toHaveLength(1);
  });

  it("шаблон ничего не проводит: сервис не зовёт проведение, только создание черновика", async () => {
    const { service, submit } = rig();
    await service.create(actor, vpsBody);
    await service.draftPeriod(actor, "2026-11", NOW);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("проверка базы: месяц шаблона", () => {
  // NULL в CHECK считается успехом, поэтому «месяц между 1 и 12» без явного «не пусто» пропускает годовой шаблон без месяца.
  // Саму проверку на живой базе гоняет ledger-templates.integration.test.ts; здесь — страховка без базы.
  const migration = readFileSync(join(import.meta.dirname, "../prisma/migrations/20261113200000_ledger_templates/migration.sql"), "utf8");

  it("у годового шаблона месяц обязателен явно, у месячного — пуст", () => {
    expect(migration).toContain(`("schedule" = 'yearly' AND "month" IS NOT NULL AND "month" BETWEEN 1 AND 12)`);
    expect(migration).toContain(`("schedule" = 'monthly' AND "month" IS NULL)`);
  });
});
