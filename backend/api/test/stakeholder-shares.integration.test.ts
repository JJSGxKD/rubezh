import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { PrismaRolesRepository } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { PrismaStakeholdersRepository } from "../src/modules/stakeholders/stakeholders.repository.js";
import { StakeholdersService } from "../src/modules/stakeholders/stakeholders.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Доли участников проекта на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL,
 * без него пропуск; Р217, tasks/T-0452): запись на месяц заменяется, а не копится, сумма долей не уходит за
 * 100 % и под гонкой двух записей, база сама не принимает доли вне 0…100 % и месяц не с первого числа.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
/** Текущее время теста: месяц — 2026-11. */
const NOW = new Date(Date.UTC(2026, 10, 13, 12));

describe.skipIf(DATABASE_URL === "")("доли участников на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let rolesRepository: PrismaRolesRepository;
  let service: StakeholdersService;
  let owner: AccountRef;

  async function person(name: string, roles: Role[] = []): Promise<AccountRef> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 60_000_000)), displayName: name, username: null, photoUrl: null },
      NOW.getTime(),
    );
    for (const role of roles) await rolesRepository.grant(created.accountId, role, null);
    return { accountId: created.accountId, platform: created.platform, platformUserId: created.platformUserId };
  }

  const set = (accountId: string, sharePercent: number, fromMonth: string, note = "договорённость от 13.11", actor: AccountRef = owner) =>
    service.setShare(actor, accountId, { sharePercent, fromMonth, note }, NOW);

  const rowsOf = (accountId: string) => prisma.stakeholderShare.findMany({ where: { accountId }, orderBy: { fromMonth: "asc" } });

  const auditOf = (accountId: string) => prisma.auditEntry.findMany({ where: { action: "stakeholders.share.set", target: accountId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    accounts = new PrismaAccountRepository(prisma);
    rolesRepository = new PrismaRolesRepository(prisma);
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    const roles = new RolesService(config, rolesRepository, accounts);
    service = new StakeholdersService(roles, new PrismaStakeholdersRepository(prisma));
    owner = await person("Владелец", ["owner"]);
  });

  // Сумма долей — на всех участников сразу, поэтому таблица чистится: другие файлы в неё не пишут
  beforeEach(async () => {
    await prisma.stakeholderShare.deleteMany();
  });

  afterAll(async () => {
    await prisma.stakeholderShare.deleteMany();
    await prisma.$disconnect();
  });

  it("назначение и замена записи того же месяца: одна строка, аудит с было и стало", async () => {
    const anna = await person("Анна", ["stakeholder"]);

    await set(anna.accountId, 25.5, "2026-12");
    expect(await rowsOf(anna.accountId)).toMatchObject([{ fromMonth: new Date("2026-12-01T00:00:00Z"), shareBp: 2_550, note: "договорённость от 13.11", setBy: owner.accountId }]);

    await set(anna.accountId, 30, "2026-12", "уточнили долю");
    const rows = await rowsOf(anna.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shareBp: 3_000, note: "уточнили долю" });

    const audit = await auditOf(anna.accountId);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actorAccountId: owner.accountId, before: null, after: { fromMonth: "2026-12", sharePercent: 25.5 } });
    expect(audit[1]).toMatchObject({ before: { fromMonth: "2026-12", sharePercent: 25.5 }, after: { fromMonth: "2026-12", sharePercent: 30 } });
  });

  it("повтор того же запроса безопасен: строка одна, значение то же", async () => {
    const anna = await person("Анна", ["stakeholder"]);

    await set(anna.accountId, 12.34, "2026-12");
    await set(anna.accountId, 12.34, "2026-12");

    const rows = await rowsOf(anna.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shareBp).toBe(1_234);
  });

  it("история не теряется: новый месяц — новая строка, в ответе новые сверху, текущая и будущая доли", async () => {
    const anna = await person("Анна", ["stakeholder"]);
    await set(anna.accountId, 20, "2026-11");
    await set(anna.accountId, 25.5, "2026-12");

    const view = await service.list(owner, NOW);
    const entry = view.participants.find((participant) => participant.accountId === anna.accountId);

    expect(entry).toMatchObject({ name: "Анна", hasRole: true, current: { sharePercent: 20, fromMonth: "2026-11" }, next: { sharePercent: 25.5, fromMonth: "2026-12" } });
    expect(entry?.history.map((row) => row.fromMonth)).toEqual(["2026-12", "2026-11"]);
    expect(entry?.history[0]).toMatchObject({ note: "договорённость от 13.11", setBy: "Владелец" });
    expect(view.ownerSharePercent).toBe(80);
  });

  it("две параллельные записи по 60 % двум участникам: одна проходит, вторая — stakeholder_shares_over", async () => {
    for (let round = 0; round < 5; round += 1) {
      await prisma.stakeholderShare.deleteMany();
      const first = await person("Первый", ["stakeholder"]);
      const second = await person("Второй", ["stakeholder"]);

      const results = await Promise.allSettled([set(first.accountId, 60, "2026-12"), set(second.accountId, 60, "2026-12")]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled, `раунд ${round}`).toHaveLength(1);
      expect(rejected, `раунд ${round}`).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(DomainError);
      expect(rejected[0]?.reason).toMatchObject({ code: "stakeholder_shares_over", status: 409 });
      expect(await prisma.stakeholderShare.count()).toBe(1);
    }
  });

  it("превышение — на любом месяце: будущая запись другого участника тоже считается", async () => {
    const first = await person("Первый", ["stakeholder"]);
    const second = await person("Второй", ["stakeholder"]);
    await set(first.accountId, 70, "2027-02");

    await expect(set(second.accountId, 40, "2026-12")).rejects.toMatchObject({ code: "stakeholder_shares_over", status: 409 });
    await expect(set(second.accountId, 40, "2026-12")).rejects.toThrow(/110/);
    expect(await rowsOf(second.accountId)).toHaveLength(0);
    // 30 % с декабря ещё в пределе: 30 + 70
    await set(second.accountId, 30, "2026-12");
    expect(await rowsOf(second.accountId)).toHaveLength(1);
  });

  it("доля больше нуля аккаунту без роли — stakeholder_role_required, а 0 % такому проходит", async () => {
    const stranger = await person("Без роли");

    await expect(set(stranger.accountId, 5, "2026-12")).rejects.toMatchObject({ code: "stakeholder_role_required", status: 409 });
    expect(await rowsOf(stranger.accountId)).toHaveLength(0);

    await set(stranger.accountId, 0, "2026-12");
    expect(await rowsOf(stranger.accountId)).toMatchObject([{ shareBp: 0 }]);
  });

  it("снятие роли доли не стирает: в списке участник остаётся с hasRole false", async () => {
    const anna = await person("Анна", ["stakeholder"]);
    await set(anna.accountId, 15, "2026-11");
    await rolesRepository.revoke(anna.accountId, "stakeholder");

    const entry = (await service.list(owner, NOW)).participants.find((participant) => participant.accountId === anna.accountId);

    expect(entry).toMatchObject({ hasRole: false, current: { sharePercent: 15, fromMonth: "2026-11" } });
    // а ноль без роли ставится — так владелец закрывает участие
    await set(anna.accountId, 0, "2026-12");
    expect(await rowsOf(anna.accountId)).toHaveLength(2);
  });

  it("месяц раньше текущего — stakeholder_month_past; текущий месяц ещё можно", async () => {
    const anna = await person("Анна", ["stakeholder"]);

    await expect(set(anna.accountId, 10, "2026-10")).rejects.toMatchObject({ code: "stakeholder_month_past", status: 400 });
    expect(await rowsOf(anna.accountId)).toHaveLength(0);

    await set(anna.accountId, 10, "2026-11");
    expect(await rowsOf(anna.accountId)).toHaveLength(1);
  });

  it("менять долю может только владелец: у финансов и участника — отказ, строк нет, аудита нет", async () => {
    const anna = await person("Анна", ["stakeholder"]);
    const finance = await person("Финансы", ["finance"]);

    await expect(set(anna.accountId, 10, "2026-12", "причина", finance)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(set(anna.accountId, 10, "2026-12", "причина", anna)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(await rowsOf(anna.accountId)).toHaveLength(0);
    expect(await auditOf(anna.accountId)).toHaveLength(0);
  });

  it("аккаунта нет — 404", async () => {
    await expect(set(randomUUID(), 10, "2026-12")).rejects.toMatchObject({ status: 404 });
  });

  it("список видят участник и финансы, а посторонний — нет", async () => {
    const anna = await person("Анна", ["stakeholder"]);
    const finance = await person("Финансы", ["finance"]);
    const player = await person("Игрок");
    await set(anna.accountId, 10, "2026-11");

    expect((await service.list(anna, NOW)).participants.map((row) => row.accountId)).toContain(anna.accountId);
    expect((await service.list(finance, NOW)).participants.map((row) => row.accountId)).toContain(anna.accountId);
    await expect(service.list(player, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it("база сама не принимает долю вне 0…100 % и месяц не с первого числа", async () => {
    const anna = await person("Анна", ["stakeholder"]);
    const base = { shareId: randomUUID(), accountId: anna.accountId, note: "проверка", setBy: owner.accountId };

    await expect(prisma.stakeholderShare.create({ data: { ...base, fromMonth: new Date("2026-12-01T00:00:00Z"), shareBp: 10_001 } })).rejects.toThrow();
    await expect(prisma.stakeholderShare.create({ data: { ...base, shareId: randomUUID(), fromMonth: new Date("2026-12-01T00:00:00Z"), shareBp: -1 } })).rejects.toThrow();
    await expect(prisma.stakeholderShare.create({ data: { ...base, shareId: randomUUID(), fromMonth: new Date("2026-12-15T00:00:00Z"), shareBp: 100 } })).rejects.toThrow();
    expect(await rowsOf(anna.accountId)).toHaveLength(0);
  });
});
