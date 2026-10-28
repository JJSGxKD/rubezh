import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { PlayerFilters, PlayerSort } from "../src/modules/player-list/player-list-query.js";
import { PrismaPlayerListRepository } from "../src/modules/player-list/player-list.repository.js";
import type { ImposeInput } from "../src/modules/restrictions/restriction-rules.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { PrismaRestrictionsRepository, REPLACED_COMMENT, type NewRestriction, type RestrictionsRepository } from "../src/modules/restrictions/restrictions.repository.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Ограничения на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): одно действующее ограничение вида на
 * игрока и под гонкой двух модераторов, снятое второй раз не снимается,
 * задача по сроку видит только несведённые, а база не примет молчаливую
 * блокировку и срок раньше начала. Системное ограничение не ослабляет
 * решение человека и в гонке: проверка «не слабее» идёт под блокировкой
 * аккаунта, той же, под которой пишут модераторы (T-0345).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 9, 1, 12));
const DAY = 86_400_000;

/**
 * Репозиторий, у которого следующее наложение от системы (`imposedBy: null`)
 * доходит до входа и ждёт сигнала: так тест ставит человека ровно между тем,
 * как система решила наложить, и тем, как она пишет, — без пауз на глаз.
 */
class ArmedRestrictionsRepository extends PrismaRestrictionsRepository {
  private armed: { reached: () => void; released: Promise<void> } | null = null;

  arm(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedSignal = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.armed = { reached, released };
    return { reached: reachedSignal, release };
  }

  override async impose(...args: Parameters<PrismaRestrictionsRepository["impose"]>): ReturnType<PrismaRestrictionsRepository["impose"]> {
    const armed = args[0][0]?.imposedBy === null ? this.armed : null;
    if (armed !== null) {
      this.armed = null;
      armed.reached();
      await armed.released;
    }
    return await super.impose(...args);
  }
}

describe.skipIf(DATABASE_URL === "")("ограничения на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaRestrictionsRepository;

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaRestrictionsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function person(): Promise<AccountRef> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 60_000_000)), displayName: "Ограничения", username: null },
      Date.now(),
    );
    return { accountId: created.accountId, platform: created.platform, platformUserId: created.platformUserId };
  }

  async function account(): Promise<string> {
    return (await person()).accountId;
  }

  const row = (accountId: string, imposedBy: string | null, patch: Partial<NewRestriction> = {}): NewRestriction => ({
    accountId,
    kind: "promo_codes",
    startsAt: NOW,
    endsAt: new Date(NOW.getTime() + DAY),
    reason: "promo_abuse",
    comment: null,
    notify: true,
    imposedBy,
    ...patch,
  });

  it("новое того же вида снимает действующее; разом от двух модераторов — действующее одно", async () => {
    const [target, first, second] = [await account(), await account(), await account()];
    await repository.impose([row(target, first)], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    await Promise.all([repository.impose([row(target, first, { startsAt: later })], later), repository.impose([row(target, second, { startsAt: later })], later)]);

    const active = await repository.active(target, later);
    expect(active).toHaveLength(1);
    const history = await repository.byAccount(target, 10);
    expect(history).toHaveLength(3);
    expect(history.filter((item) => item.liftComment === REPLACED_COMMENT)).toHaveLength(2);
  });

  it("снять можно только действующее и только однажды; истёкшее не снимается", async () => {
    const [target, moderator] = [await account(), await account()];
    const { created } = await repository.impose([row(target, moderator), row(target, moderator, { kind: "ad_rewards", endsAt: new Date(NOW.getTime() + 60_000) })], NOW);
    const [promo, ads] = created;
    const lifted = await Promise.all([repository.lift(promo?.restrictionId ?? "", moderator, "ошибка", NOW), repository.lift(promo?.restrictionId ?? "", moderator, "ещё раз", NOW)]);
    const winners = lifted.filter((item) => item !== null);
    expect(winners).toHaveLength(1);
    // Кто успел первым — решает база; проигравший не перепишет причину победившего.
    expect((await repository.byId(promo?.restrictionId ?? ""))?.liftComment).toBe(winners[0]?.liftComment);
    expect(await repository.lift(ads?.restrictionId ?? "", moderator, "поздно", new Date(NOW.getTime() + 120_000))).toBeNull();
  });

  it("задача по сроку видит снятые и истёкшие без отметки — и не видит их после неё", async () => {
    const [target, moderator] = [await account(), await account()];
    const at = new Date(Date.UTC(2031, 0, 1));
    const { created } = await repository.impose(
      [row(target, moderator, { kind: "all", startsAt: at, endsAt: new Date(at.getTime() + DAY) }), row(target, moderator, { kind: "friend_gifts", startsAt: at, endsAt: null })],
      at,
    );
    const ids = created.map((item) => item.restrictionId);
    const later = new Date(at.getTime() + DAY + 1);
    const due = (await repository.unsettled(later, 10_000)).filter((item) => ids.includes(item.restrictionId));
    expect(due.map((item) => item.kind)).toEqual(["all"]);
    await repository.markSettled(due.map((item) => item.restrictionId), later);
    expect((await repository.unsettled(later, 10_000)).filter((item) => ids.includes(item.restrictionId))).toEqual([]);
  });

  it("кому закрыт вид сейчас: действующие этих видов, без снятых, истёкших и чужих видов — по аккаунту один раз", async () => {
    const [both, expired, lifted, other, moderator] = [await account(), await account(), await account(), await account(), await account()];
    const at = new Date(Date.UTC(2032, 0, 1));
    await repository.impose([row(both, moderator, { kind: "leaderboard", startsAt: at, endsAt: null }), row(both, moderator, { kind: "all", startsAt: at, endsAt: null })], at);
    await repository.impose([row(expired, moderator, { kind: "leaderboard", startsAt: at, endsAt: new Date(at.getTime() + 1_000) })], at);
    const { created } = await repository.impose([row(lifted, moderator, { kind: "leaderboard", startsAt: at, endsAt: null })], at);
    await repository.lift(created[0]?.restrictionId ?? "", moderator, "снято", at);
    await repository.impose([row(other, moderator, { kind: "promo_codes", startsAt: at, endsAt: null })], at);

    const later = new Date(at.getTime() + 60_000);
    const found = (await repository.activeAccounts(["leaderboard", "all"], later, 100_000)).filter((id) => [both, expired, lifted, other].includes(id));
    expect(found).toEqual([both]);
  });

  it("база держит форму: блокировка — не молча, срок после начала, снятие — с причиной; удалённый аккаунт уносит свои строки", async () => {
    const [target, moderator] = [await account(), await account()];
    await expect(repository.impose([row(target, moderator, { kind: "all", notify: false })], NOW)).rejects.toThrow();
    await expect(repository.impose([row(target, moderator, { endsAt: new Date(NOW.getTime() - 1) })], NOW)).rejects.toThrow();
    await expect(repository.impose([row(target, moderator, { kind: "Bad Kind" })], NOW)).rejects.toThrow();
    const { created } = await repository.impose([row(target, moderator)], NOW);
    await expect(prisma.$executeRaw`UPDATE account_restriction SET lifted_at = now() WHERE restriction_id = ${created[0]?.restrictionId ?? ""}::uuid`).rejects.toThrow();

    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${target}::uuid`;
    expect(await repository.byAccount(target, 10)).toEqual([]);
  });

  it("скрытый вид: база его принимает, он действует и виден порту «можно ли»", async () => {
    const [target, owner] = [await account(), await account()];
    const at = new Date();
    const { created } = await repository.impose([row(target, owner, { kind: "separate_board", startsAt: at, endsAt: null, notify: false })], at);

    expect(created[0]).toMatchObject({ kind: "separate_board", notify: false });
    expect((await repository.active(target, at)).map((item) => item.kind)).toEqual(["separate_board"]);
    expect(await repository.activeAccounts(["separate_board"], at, 100_000)).toContain(target);
  });

  it("список игроков: без права вид исключён из видов строки и из фильтров «any», «none» и по самому виду; с правом — как у остальных", async () => {
    const [onlyHidden, mixed, plain, owner] = [await account(), await account(), await account(), await account()];
    const at = new Date();
    const own = (accountId: string, kind: string) => row(accountId, owner, { kind, startsAt: at, endsAt: null, notify: false });
    await repository.impose([own(onlyHidden, "separate_board"), own(mixed, "separate_board"), own(mixed, "promo_codes")], at);
    const lists = new PrismaPlayerListRepository(prisma);
    const mine = [onlyHidden, mixed, plain];
    const found = async (restricted: PlayerFilters["restricted"], showHidden: boolean, sort: PlayerSort = "registered") => {
      const rows = await lists.page({ filters: { restricted }, sort, order: "desc", cursor: null, limit: 100_000, showHidden });
      return new Map(rows.filter((item) => mine.includes(item.accountId)).map((item) => [item.accountId, item.restrictions]));
    };

    for (const sort of ["registered", "level"] as const) {
      const blind = await found("any", false, sort);
      expect([...blind.keys()].sort(), sort).toEqual([mixed]);
      expect(blind.get(mixed), sort).toEqual(["promo_codes"]);

      const sighted = await found("any", true, sort);
      expect([...sighted.keys()].sort(), sort).toEqual([onlyHidden, mixed].sort());
      expect(sighted.get(onlyHidden), sort).toEqual(["separate_board"]);
      expect(sighted.get(mixed), sort).toEqual(["promo_codes", "separate_board"]);
    }

    // «Без ограничений» без права включает аккаунт, у которого только скрытый вид, — для сотрудника его нет.
    expect([...(await found("none", false)).keys()].sort()).toEqual([onlyHidden, plain].sort());
    expect([...(await found("none", true)).keys()]).toEqual([plain]);
    // Фильтр по самому виду без права не находит никого.
    expect((await found("separate_board", false)).size).toBe(0);
    expect([...(await found("separate_board", true)).keys()].sort()).toEqual([onlyHidden, mixed].sort());
    // Без указания «видит скрытые» вид исключён — безопасное умолчание.
    const rows = await lists.page({ filters: { restricted: "any" }, sort: "registered", order: "desc", cursor: null, limit: 100_000 });
    expect(rows.some((item) => item.accountId === onlyHidden)).toBe(false);
  });

  describe("системное ограничение: проверка «не слабее» под блокировкой аккаунта (T-0345)", () => {
    const TERM = 30 * DAY;
    const COMMENT = "Отписка от канала после награды за подписку";
    const ONE_ROW_ONLY = "keepIfStanding — только для одной строки";
    const system = (accountId: string, patch: Partial<NewRestriction> = {}) =>
      row(accountId, null, { kind: "partner_tasks", endsAt: new Date(NOW.getTime() + TERM), reason: "task_unsubscribe", ...patch });

    /** Сервис ограничений поверх живой базы; роли и журнал — в памяти, они к гонке не относятся. */
    async function serviceOver(source: RestrictionsRepository) {
      const roles = new MemoryRolesRepository();
      const rolesService = new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), roles, accounts);
      const service = new RestrictionsService(source, accounts, rolesService, restrictionsGate(source), new RestrictionsHooks());
      const moderator = await person();
      await roles.grant(moderator.accountId, "moderator", null);
      return { service, moderator };
    }

    const indefinite: ImposeInput = { kinds: ["partner_tasks"], endsAt: null, reason: "abuse", comment: "решение модератора", notify: true };

    it("при действующей блокировке целиком `keepIfStanding` отвечает `kept`: строк не прибавилось", async () => {
      const [target, owner] = [await account(), await account()];
      await repository.impose([row(target, owner, { kind: "all", endsAt: null })], NOW);

      const result = await repository.impose([system(target)], NOW, { keepIfStanding: true });

      expect(result).toEqual({ created: [], replaced: [], kept: true });
      const history = await repository.byAccount(target, 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ kind: "all", liftedAt: null });
    });

    it("при более коротком ограничении вида `keepIfStanding` заменяет его: `kept: false`, короткое снято с REPLACED_COMMENT, новое создано", async () => {
      const [target, moderator] = [await account(), await account()];
      await repository.impose([system(target, { imposedBy: moderator, endsAt: new Date(NOW.getTime() + 10 * DAY) })], NOW);

      const result = await repository.impose([system(target)], NOW, { keepIfStanding: true });

      expect(result.kept).toBe(false);
      expect(result.created).toHaveLength(1);
      expect(result.replaced).toHaveLength(1);
      expect(result.replaced[0]).toMatchObject({ imposedBy: moderator, liftedAt: NOW, liftComment: REPLACED_COMMENT });
      const history = await repository.byAccount(target, 10);
      expect(history).toHaveLength(2);
      expect(history.filter((item) => item.liftComment === REPLACED_COMMENT)).toHaveLength(1);
      const standing = await repository.active(target, NOW);
      expect(standing).toHaveLength(1);
      expect(standing[0]).toMatchObject({ endsAt: new Date(NOW.getTime() + TERM), reason: "task_unsubscribe", imposedBy: null });
    });

    it("бессрочное и равное по сроку ограничение вида держат новое; другой вид, истёкшее и снятое — нет", async () => {
      const [forever, equal, otherKind, expired, lifted, moderator] = [await account(), await account(), await account(), await account(), await account(), await account()];
      const earlier = new Date(NOW.getTime() - 5 * DAY);
      await repository.impose([system(forever, { imposedBy: moderator, endsAt: null })], NOW);
      await repository.impose([system(equal, { imposedBy: moderator })], NOW);
      await repository.impose([system(otherKind, { imposedBy: moderator, kind: "promo_codes", endsAt: null })], NOW);
      await repository.impose([system(expired, { imposedBy: moderator, startsAt: earlier, endsAt: new Date(NOW.getTime() - 1) })], earlier);
      const { created } = await repository.impose([system(lifted, { imposedBy: moderator, endsAt: null })], NOW);
      await repository.lift(created[0]?.restrictionId ?? "", moderator, "снято", NOW);

      const kept = async (accountId: string) => (await repository.impose([system(accountId)], NOW, { keepIfStanding: true })).kept;

      expect(await kept(forever)).toBe(true);
      expect(await kept(equal)).toBe(true);
      expect(await kept(otherKind)).toBe(false);
      expect(await kept(expired)).toBe(false);
      expect(await kept(lifted)).toBe(false);
      expect((await repository.active(forever, NOW)).map((item) => item.imposedBy)).toEqual([moderator]);
    });

    it("`keepIfStanding` с двумя строками или без строк — ошибка, ничего не записано и прежнее не снято", async () => {
      const [target, moderator] = [await account(), await account()];
      await repository.impose([system(target, { imposedBy: moderator, endsAt: new Date(NOW.getTime() + DAY) })], NOW);

      await expect(repository.impose([system(target), system(target, { kind: "promo_codes" })], NOW, { keepIfStanding: true })).rejects.toThrow(ONE_ROW_ONLY);
      await expect(repository.impose([], NOW, { keepIfStanding: true })).rejects.toThrow(ONE_ROW_ONLY);

      const history = await repository.byAccount(target, 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ imposedBy: moderator, liftedAt: null });
    });

    it("без опции `kept` всегда `false`: модератор по-прежнему заменяет действующее ограничение вида любым своим", async () => {
      const [target, moderator] = [await account(), await account()];
      await repository.impose([system(target, { imposedBy: moderator, endsAt: null })], NOW);

      const result = await repository.impose([system(target, { imposedBy: moderator, endsAt: new Date(NOW.getTime() + DAY) })], NOW);

      expect(result.kept).toBe(false);
      expect(result.replaced).toHaveLength(1);
      expect(await repository.active(target, NOW)).toHaveLength(1);
    });

    it("модератор успевает между решением системы и её записью: система не заменяет его бессрочное ограничение своим на 30 суток", async () => {
      const armed = new ArmedRestrictionsRepository(prisma);
      const { service, moderator } = await serviceOver(armed);
      const target = (await person()).accountId;
      const turn = armed.arm();

      const systemRun = service.imposeBySystemFor(target, "partner_tasks", "task_unsubscribe", COMMENT, TERM, NOW);
      await turn.reached;
      await service.impose(moderator, target, indefinite, NOW);
      turn.release();

      expect(await systemRun).toBe("kept");
      const standing = await repository.active(target, NOW);
      expect(standing).toHaveLength(1);
      expect(standing[0]).toMatchObject({ kind: "partner_tasks", endsAt: null, imposedBy: moderator.accountId });
      expect(await repository.byAccount(target, 10)).toHaveLength(1);
    }, 30_000);

    it("система успела первой, модератор после: его бессрочное заменяет системное, и действующее одно", async () => {
      const { service, moderator } = await serviceOver(repository);
      const target = (await person()).accountId;

      expect(await service.imposeBySystemFor(target, "partner_tasks", "task_unsubscribe", COMMENT, TERM, NOW)).toBe("imposed");
      await service.impose(moderator, target, indefinite, NOW);

      const standing = await repository.active(target, NOW);
      expect(standing).toHaveLength(1);
      expect(standing[0]).toMatchObject({ endsAt: null, imposedBy: moderator.accountId });
      const history = await repository.byAccount(target, 10);
      expect(history.filter((item) => item.liftComment === REPLACED_COMMENT)).toHaveLength(1);
    }, 30_000);

    it("гонка модератора и системы, 20 повторов с разным порядком запуска: в конце действует одна строка вида — бессрочная модератора", async () => {
      const { service, moderator } = await serviceOver(repository);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const target = (await person()).accountId;
        const at = new Date();
        const byModerator = () => service.impose(moderator, target, indefinite, at);
        const bySystem = () => service.imposeBySystemFor(target, "partner_tasks", "task_unsubscribe", COMMENT, TERM, at);

        // Чётные повторы запускают первым модератора, нечётные — систему: гонка идёт в обоих порядках.
        if (attempt % 2 === 0) await Promise.all([byModerator(), bySystem()]);
        else await Promise.all([bySystem(), byModerator()]);

        const standing = (await repository.active(target, at)).filter((item) => item.kind === "partner_tasks");
        expect(standing, `повтор ${attempt}`).toHaveLength(1);
        expect(standing[0], `повтор ${attempt}`).toMatchObject({ endsAt: null, imposedBy: moderator.accountId });
      }
    }, 120_000);
  });
});
