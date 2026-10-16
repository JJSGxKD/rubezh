import "reflect-metadata";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminPlayersService } from "../src/modules/admin/admin-players.service.js";
import { AdminRestrictionsController } from "../src/modules/admin/admin-restrictions.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { AccountRestrictions } from "../src/modules/restrictions/account-restrictions.js";
import { HIDDEN_KINDS, RESTRICTION_CATALOG, RESTRICTION_KINDS, RESTRICTION_REASONS, isHiddenKind, type RestrictionKind } from "../src/modules/restrictions/restriction-catalog.js";
import { banMessage, imposeProblem, imposeSchema, playerMessage, shownText, termProblem, untilText } from "../src/modules/restrictions/restriction-rules.js";
import { RestrictionsController } from "../src/modules/restrictions/restrictions.controller.js";
import { AccountRestrictedError, RestrictionNotFoundError, RestrictionSilentError } from "../src/modules/restrictions/restrictions-errors.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import { RestrictionsSettler } from "../src/modules/restrictions/restrictions-settler.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, type Role } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Ограничения игрока (docs/35-stage4-plan.md Р75, WP44): закрыть часть
 * функций на срок. Действует — не снято и срок не вышел; блокировка целиком
 * закрывает и всё остальное; игрок, которому решили сообщить, узнаёт, что
 * закрыто, до какого числа и почему, — молчаливое отказывает нейтрально.
 */

const OWNER_ID = "777000111";
/** четверг, 01.10.2026, 12:00 UTC — 15:00 по Москве */
const NOW = new Date(Date.UTC(2026, 9, 1, 12));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);

function setup() {
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const repository = new MemoryRestrictionsRepository();
  const gate = restrictionsGate(repository);
  const rolesService = new RolesService(config(), roles, accounts);
  const hooks = new RestrictionsHooks();
  const service = new RestrictionsService(repository, accounts, rolesService, gate, hooks);
  return { accounts, roles, repository, gate, service, hooks };
}

async function person(s: ReturnType<typeof setup>, id: string, role?: Role): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, NOW.getTime());
  if (role !== undefined) await s.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

const input = (patch: Partial<Parameters<RestrictionsService["impose"]>[2]> = {}) => ({
  kinds: ["promo_codes" as RestrictionKind],
  endsAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
  reason: "promo_abuse" as const,
  comment: "двадцать кодов за час",
  notify: true,
  ...patch,
});

describe("правила ограничений", () => {
  it("срок: от десяти минут до пяти лет, бессрочно — можно", () => {
    expect(termProblem(null, NOW)).toBeNull();
    expect(termProblem(new Date(NOW.getTime() + DAY), NOW)).toBeNull();
    expect(termProblem(new Date(NOW.getTime() - 1), NOW)).toContain("Срок уже прошёл");
    expect(termProblem(new Date(NOW.getTime() + 5 * 60_000), NOW)).toContain("Срок уже прошёл");
    expect(termProblem(new Date(NOW.getTime() + 6 * 366 * DAY), NOW)).toContain("бессрочно");
  });

  it("молча нельзя только то, что игрок увидит всё равно: блокировку целиком", () => {
    expect(imposeProblem(["promo_codes", "ad_rewards"], false)).toBeNull();
    expect(imposeProblem(["promo_codes", "all"], false)).toContain("«Всё — блокировка» молча не накладывается");
    expect(imposeProblem(["all"], true)).toBeNull();
    expect(RESTRICTION_KINDS.filter((kind) => !RESTRICTION_CATALOG[kind].silentAllowed)).toEqual(["purchases", "all"]);
    // Покупки закрыты — игрок упрётся в отказ при оплате и без плашки.
    expect(imposeProblem(["purchases"], false)).toContain("«Покупки» молча не накладывается");
  });

  it("игрок видит, что закрыто, до какого числа по Москве и причину шаблона", () => {
    const endsAt = new Date(NOW.getTime() + 3 * DAY);
    expect(untilText(endsAt)).toBe("до 4 октября, 15:00 МСК");
    expect(playerMessage({ kind: "ad_rewards", endsAt, reason: "ad_abuse" })).toBe("Награды за рекламу — закрыто до 4 октября, 15:00 МСК. Причина: Неестественные просмотры рекламы");
    expect(banMessage({ endsAt: null, reason: "abuse" })).toBe("Аккаунт заблокирован бессрочно. Причина: Оскорбления или спам");
    // Ключ причины новее кода — читается как «другое», а не как пустота.
    expect(playerMessage({ kind: "promo_codes", endsAt: null, reason: "future_reason" })).toContain(RESTRICTION_REASONS.other.player);
  });

  it("текст блокировки с самой длинной датой помещается в отметку аккаунта — `ban_reason` до 256 знаков", () => {
    const longest = new Date(Date.UTC(2026, 10, 30, 20, 59));
    for (const reason of Object.keys(RESTRICTION_REASONS)) expect(banMessage({ endsAt: longest, reason }).length, reason).toBeLessThanOrEqual(256);
  });

  it("предпросмотр: игрок увидит тот же текст, что в отказе; молча — нейтральное «недоступно», рейтинг — ничего; проблема черновика — словами", async () => {
    const s = setup();
    const moderator = await person(s, "500", "moderator");
    const endsAt = new Date(NOW.getTime() + 3 * DAY).toISOString();
    const told = await s.service.preview(moderator, { kinds: ["promo_codes", "all"], endsAt, reason: "promo_abuse", notify: true }, NOW);
    expect(told.problem).toBeNull();
    expect(told.shown).toEqual([
      { kind: "promo_codes", title: "Промокоды", text: "Промокоды — закрыто до 4 октября, 15:00 МСК. Причина: Промокоды использовались не по правилам" },
      { kind: "all", title: "Всё — блокировка", text: "Аккаунт заблокирован до 4 октября, 15:00 МСК. Причина: Промокоды использовались не по правилам" },
    ]);
    const silent = await s.service.preview(moderator, { kinds: ["ad_rewards", "leaderboard"], endsAt: null, reason: "ad_abuse", notify: false }, NOW);
    expect(silent.shown.map((item) => item.text)).toEqual(["Сейчас недоступно — попробуйте позже", expect.stringMatching(/^Ничего: в рейтинге игрок видит себя/)]);
    expect((await s.service.preview(moderator, { kinds: ["all"], endsAt: null, reason: "abuse", notify: false }, NOW)).problem).toMatch(/молча не накладывается/);
    expect((await s.service.preview(moderator, { kinds: ["promo_codes"], endsAt: new Date(NOW.getTime() - DAY).toISOString(), reason: "abuse", notify: true }, NOW)).problem).toMatch(/Срок уже прошёл/);
  });

  it("вход панели: виды без повторов, причина из шаблонов, комментарий ограничен, лишнее поле — отказ", () => {
    expect(imposeSchema.safeParse(input()).success).toBe(true);
    expect(imposeSchema.safeParse(input({ kinds: [] })).success).toBe(false);
    expect(imposeSchema.safeParse(input({ kinds: ["promo_codes", "promo_codes"] })).success).toBe(false);
    expect(imposeSchema.safeParse({ ...input(), reason: "просто так" }).success).toBe(false);
    expect(imposeSchema.safeParse(input({ comment: "x".repeat(501) })).success).toBe(false);
    expect(imposeSchema.safeParse({ ...input(), extra: 1 }).success).toBe(false);
  });
});

describe("порт «можно ли»", () => {
  it("закрыт свой вид и всё при блокировке; снятое и истёкшее — не держат", async () => {
    const s = setup();
    s.repository.restrict("a", "promo_codes");
    s.repository.restrict("b", "all");
    s.repository.restrict("c", "promo_codes", { endsAt: new Date(NOW.getTime() - 1) });
    Object.assign(s.repository.restrict("d", "promo_codes"), { liftedAt: NOW, liftComment: "ошибка" });

    expect((await s.gate.status("a", "promo_codes", NOW))?.kind).toBe("promo_codes");
    expect(await s.gate.status("a", "ad_rewards", NOW)).toBeNull();
    expect((await s.gate.status("b", "friend_gifts", NOW))?.kind).toBe("all");
    expect(await s.gate.status("c", "promo_codes", NOW)).toBeNull();
    expect(await s.gate.status("d", "promo_codes", NOW)).toBeNull();
  });

  it("отказ: сообщили — что, до когда и почему; молча — как временный сбой", async () => {
    const s = setup();
    s.repository.restrict("loud", "promo_codes", { endsAt: new Date(NOW.getTime() + DAY), reason: "promo_abuse" });
    s.repository.restrict("quiet", "promo_codes", { notify: false });
    const loud = s.gate.ensure("loud", "promo_codes", NOW);
    await expect(loud).rejects.toBeInstanceOf(AccountRestrictedError);
    await expect(loud).rejects.toThrow("Промокоды — закрыто до 2 октября, 15:00 МСК. Причина: Промокоды использовались не по правилам");
    await expect(s.gate.ensure("quiet", "promo_codes", NOW)).rejects.toBeInstanceOf(RestrictionSilentError);
    await expect(s.gate.ensure("free", "promo_codes", NOW)).resolves.toBeUndefined();
  });

  it("истечение срока кеш не держит: строка проверяется по времени в момент вопроса", async () => {
    const s = setup();
    s.repository.restrict("a", "promo_codes", { endsAt: new Date(NOW.getTime() + HOUR) });
    expect(await s.gate.status("a", "promo_codes", NOW)).not.toBeNull();
    expect(await s.gate.status("a", "promo_codes", new Date(NOW.getTime() + HOUR))).toBeNull();
    expect(s.repository.reads).toBe(1);
  });

  it("кеш на полминуты: второй вопрос — без базы; сброс — здесь и сообщением соседям", async () => {
    const s = setup();
    await s.gate.status("a", "promo_codes", NOW);
    await s.gate.status("a", "ad_rewards", NOW);
    expect(s.repository.reads).toBe(1);
    s.repository.restrict("a", "promo_codes");
    expect(await s.gate.status("a", "promo_codes", NOW)).toBeNull();
    await s.gate.forget("a");
    expect(s.gate.published).toEqual(["a"]);
    expect(await s.gate.status("a", "promo_codes", NOW)).not.toBeNull();
    expect(s.repository.reads).toBe(2);
  });

  it("игрок видит только действующие, о которых решили сообщить", async () => {
    const s = setup();
    s.repository.restrict("a", "promo_codes", { endsAt: new Date(NOW.getTime() + DAY), reason: "promo_abuse" });
    s.repository.restrict("a", "ad_rewards", { notify: false });
    s.repository.restrict("a", "friend_gifts", { endsAt: new Date(NOW.getTime() - 1) });
    expect(await s.gate.visibleFor("a", NOW)).toEqual([
      // Срок словами — тот же, что в тексте отказа: плашка клиента дату не форматирует.
      { kind: "promo_codes", title: "Промокоды", endsAt: new Date(NOW.getTime() + DAY).toISOString(), until: untilText(new Date(NOW.getTime() + DAY)), reason: "Промокоды использовались не по правилам" },
    ]);
  });
});

describe("наложение и снятие", () => {
  it("модератор ограничивает: строка на вид, кеш сброшен, решение — в журнал", async () => {
    const s = setup();
    const moderator = await person(s, "501", "moderator");
    const target = await person(s, "502");
    const views = await s.service.impose(moderator, target.accountId, input({ kinds: ["promo_codes", "ad_rewards"] }), NOW);

    expect(views.map((view) => [view.kind, view.state, view.reasonTitle, view.imposedBy?.name])).toEqual([
      ["promo_codes", "active", "Злоупотребление промокодами", "Игрок 501"],
      ["ad_rewards", "active", "Злоупотребление промокодами", "Игрок 501"],
    ]);
    expect(s.gate.published).toEqual([target.accountId]);
    await expect(s.gate.ensure(target.accountId, "ad_rewards", NOW)).rejects.toBeInstanceOf(AccountRestrictedError);
    expect(s.roles.entries.at(-1)).toMatchObject({
      action: "players.restrict",
      target: target.accountId,
      after: { restrictions: [{ kind: "promo_codes", reason: "promo_abuse", comment: "двадцать кодов за час", notify: true }, { kind: "ad_rewards" }] },
    });
  });

  it("право по виду: геймдизайнеру нельзя; себя нельзя; срок и молчание проверяются; нет аккаунта — отказ", async () => {
    const s = setup();
    const designer = await person(s, "503", "game_designer");
    const moderator = await person(s, "504", "moderator");
    const target = await person(s, "505");
    await expect(s.service.impose(designer, target.accountId, input(), NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.service.impose(moderator, moderator.accountId, input(), NOW)).rejects.toThrow("Ограничить себя нельзя");
    await expect(s.service.impose(moderator, target.accountId, input({ endsAt: new Date(NOW.getTime() - DAY).toISOString() }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(s.service.impose(moderator, target.accountId, input({ kinds: ["all"], notify: false }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(s.service.impose(moderator, "00000000-0000-4000-8000-000000000999", input(), NOW)).rejects.toThrow("Аккаунт не найден");
    expect(s.repository.rows).toEqual([]);
  });

  it("новое того же вида заменяет действующее — у прежнего так и записано, история не теряется", async () => {
    const s = setup();
    const moderator = await person(s, "506", "moderator");
    const target = await person(s, "507");
    await s.service.impose(moderator, target.accountId, input(), NOW);
    await s.service.impose(moderator, target.accountId, input({ endsAt: null, reason: "multiaccount" }), new Date(NOW.getTime() + HOUR));

    const history = await s.service.history(moderator, target.accountId, new Date(NOW.getTime() + HOUR));
    expect(history.map((view) => [view.state, view.endsAt])).toEqual([
      ["active", null],
      ["replaced", new Date(NOW.getTime() + 3 * DAY).toISOString()],
    ]);
    expect((await s.gate.status(target.accountId, "promo_codes", new Date(NOW.getTime() + 10 * DAY)))?.reason).toBe("multiaccount");
  });

  it("блокировка целиком ставит отметку входа с причиной; снятие убирает её, повтор — «нет такого»", async () => {
    const s = setup();
    const moderator = await person(s, "508", "moderator");
    const target = await person(s, "509");
    const [banned] = await s.service.impose(moderator, target.accountId, input({ kinds: ["all"], reason: "abuse", endsAt: null }), NOW);
    expect((await s.accounts.byId(target.accountId))?.banReason).toBe("Аккаунт заблокирован бессрочно. Причина: Оскорбления или спам");

    const lifted = await s.service.lift(moderator, banned?.restrictionId ?? "", "разобрались — не он", new Date(NOW.getTime() + HOUR));
    expect([lifted.state, lifted.liftComment, lifted.liftedBy?.name]).toEqual(["lifted", "разобрались — не он", "Игрок 508"]);
    expect((await s.accounts.byId(target.accountId))?.bannedAt).toBeNull();
    expect(s.repository.rows[0]?.settledAt).toEqual(new Date(NOW.getTime() + HOUR));
    await expect(s.service.lift(moderator, banned?.restrictionId ?? "", "ещё раз", new Date(NOW.getTime() + 2 * HOUR))).rejects.toBeInstanceOf(RestrictionNotFoundError);
    expect(s.roles.entries.map((entry) => entry.action)).toEqual(["players.restrict", "players.unrestrict"]);
  });

  it("снять может тот, у кого право вида: блокировку целиком — с правом на блокировку", async () => {
    const s = setup();
    const owner = await person(s, OWNER_ID);
    const designer = await person(s, "510", "game_designer");
    const target = await person(s, "511");
    const [row] = await s.service.impose(owner, target.accountId, input({ kinds: ["all"] }), NOW);
    await expect(s.service.lift(designer, row?.restrictionId ?? "", "хочу", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await s.accounts.byId(target.accountId))?.bannedAt).toEqual(NOW);
  });
});

describe("ограничение «Покупки» и наложение системой (T-0024)", () => {
  const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
  const comment = `Возврат звёзд за покупку ${PURCHASE_ID}`;

  it("вид «Покупки» в каталоге: что закрывает, где проверяется, чьё право; причина «Возврат оплаты»", async () => {
    expect(RESTRICTION_KINDS.at(-1)).toBe("all");
    expect(RESTRICTION_KINDS.at(-2)).toBe("purchases");
    expect(RESTRICTION_CATALOG.purchases).toMatchObject({
      title: "Покупки",
      checkedIn: "shop, vip, payments",
      permission: "players.restrict",
      silentAllowed: false,
    });
    expect(RESTRICTION_CATALOG.purchases.effect).toContain("магазин и VIP не выставляют счета");
    expect(RESTRICTION_CATALOG.purchases.effect).toContain("Купленное раньше остаётся");
    expect(RESTRICTION_REASONS.payment_refund).toEqual({ title: "Возврат оплаты", player: "Возврат звёзд за покупку" });
    const s = setup();
    const moderator = await person(s, "511", "moderator");
    expect((await s.service.catalog(moderator)).kinds.map((item) => item.kind)).toContain("purchases");
    expect((await s.service.catalog(moderator)).reasons).toContainEqual({ reason: "payment_refund", title: "Возврат оплаты", player: "Возврат звёзд за покупку" });
  });

  it("система накладывает без автора: бессрочно, с сообщением игроку, строка и журнал — от `null`", async () => {
    const s = setup();
    const target = await person(s, "601");
    const imposed: { accountId: string; kinds: readonly string[]; at: Date }[] = [];
    s.hooks.onImposed("проверка", async (change) => void imposed.push(change));

    await s.service.imposeBySystem(target.accountId, "purchases", "payment_refund", comment, NOW);

    expect(s.repository.rows).toHaveLength(1);
    expect(s.repository.rows[0]).toMatchObject({ accountId: target.accountId, kind: "purchases", startsAt: NOW, endsAt: null, reason: "payment_refund", comment, notify: true, imposedBy: null, liftedAt: null });
    expect(s.roles.entries.at(-1)).toMatchObject({
      actorAccountId: null,
      action: "players.restrict",
      target: target.accountId,
      after: { restrictions: [{ kind: "purchases", endsAt: null, reason: "payment_refund", comment, notify: true }] },
    });
    expect(imposed).toEqual([{ accountId: target.accountId, kinds: ["purchases"], at: NOW }]);
    expect(s.gate.published).toEqual([target.accountId]);
  });

  it("игрок видит причину шаблона словами: «Покупки — закрыто бессрочно. Причина: Возврат звёзд за покупку»", async () => {
    const s = setup();
    const target = await person(s, "602");
    await s.service.imposeBySystem(target.accountId, "purchases", "payment_refund", comment, NOW);

    await expect(s.gate.ensure(target.accountId, "purchases", NOW)).rejects.toThrow("Покупки — закрыто бессрочно. Причина: Возврат звёзд за покупку");
    await expect(s.gate.ensure(target.accountId, "promo_codes", NOW)).resolves.toBeUndefined();
    expect(await s.gate.visibleFor(target.accountId, NOW)).toMatchObject([{ kind: "purchases", title: "Покупки", endsAt: null }]);
  });

  it("повторное наложение того же вида заменяет действующее — не вторая действующая строка", async () => {
    const s = setup();
    const target = await person(s, "603");
    await s.service.imposeBySystem(target.accountId, "purchases", "payment_refund", comment, NOW);
    const later = new Date(NOW.getTime() + HOUR);

    await s.service.imposeBySystem(target.accountId, "purchases", "payment_refund", "Возврат звёзд за покупку 22222222-2222-4222-8222-222222222222", later);

    const rows = s.repository.rows.filter((row) => row.kind === "purchases");
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.liftedAt === null)).toHaveLength(1);
    expect(rows.find((row) => row.liftedAt !== null)).toMatchObject({ comment, liftComment: expect.any(String) as string });
    expect(s.roles.entries.at(-1)).toMatchObject({ before: { replaced: [{ kind: "purchases" }] } });
  });

  it("блокировку целиком система не накладывает — ошибка, ничего не записано", async () => {
    const s = setup();
    const target = await person(s, "604");

    await expect(s.service.imposeBySystem(target.accountId, "all", "other", "x", NOW)).rejects.toThrow("Систему блокировать целиком не просим");

    expect(s.repository.rows).toEqual([]);
    expect(s.roles.entries).toEqual([]);
    expect((await s.accounts.byId(target.accountId))?.bannedAt ?? null).toBeNull();
  });

  it("право для наложения системой не нужно, а снять ограничение может модератор — правом вида", async () => {
    const s = setup();
    const moderator = await person(s, "605", "moderator");
    const designer = await person(s, "606", "game_designer");
    const target = await person(s, "607");
    await s.service.imposeBySystem(target.accountId, "purchases", "payment_refund", comment, NOW);
    const row = s.repository.rows[0];

    await expect(s.service.lift(designer, row?.restrictionId ?? "", "хочу", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const lifted = await s.service.lift(moderator, row?.restrictionId ?? "", "разобрались", new Date(NOW.getTime() + HOUR));

    expect(lifted).toMatchObject({ state: "lifted", kind: "purchases", imposedBy: null });
    await expect(s.gate.ensure(target.accountId, "purchases", new Date(NOW.getTime() + 2 * HOUR))).resolves.toBeUndefined();
  });

  it("в панели это ограничение без автора: строка истории не называет модератора", async () => {
    const s = setup();
    const moderator = await person(s, "608", "moderator");
    const target = await person(s, "609");
    await s.service.imposeBySystem(target.accountId, "purchases", "payment_refund", comment, NOW);

    const [view] = await s.service.history(moderator, target.accountId, NOW);

    expect(view).toMatchObject({ kind: "purchases", state: "active", reasonTitle: "Возврат оплаты", imposedBy: null });
  });

  it("блокировка целиком закрывает и покупки: у забаненного `status('purchases')` не пуст", async () => {
    const s = setup();
    const owner = await person(s, OWNER_ID);
    const target = await person(s, "610");
    await s.service.impose(owner, target.accountId, input({ kinds: ["all"], endsAt: null }), NOW);

    expect((await s.gate.status(target.accountId, "purchases", NOW))?.kind).toBe("all");
  });
});

describe("скрытое ограничение «Отдельная доска» (T-0112)", () => {
  const MALFORMED = "Некорректное ограничение: нужны виды, срок и причина";
  const hidden = (patch: Partial<Parameters<RestrictionsService["impose"]>[2]> = {}) => input({ kinds: ["separate_board"], notify: false, reason: "leaderboard_cheat", ...patch });

  it("в каталоге: скрытый, молчаливый, право владельца, проверяется в забегах; стоит сразу после «Рейтинга», у остальных не скрыт", () => {
    expect(RESTRICTION_CATALOG.separate_board).toMatchObject({
      title: "Отдельная доска",
      checkedIn: "runs",
      permission: "players.board.restrict",
      silentAllowed: true,
      hidden: true,
    });
    expect(RESTRICTION_CATALOG.separate_board.effect).toBe(
      "Игрок остаётся в рейтинге и читает полную доску, остальные видят общую без него. Места и награды за места считаются по доске того, кто смотрит. Игрок не видит ничего. Призы — только внутриигровые",
    );
    expect(RESTRICTION_KINDS.indexOf("separate_board")).toBe(RESTRICTION_KINDS.indexOf("leaderboard") + 1);
    expect(HIDDEN_KINDS).toEqual(["separate_board"]);
    expect(RESTRICTION_KINDS.filter((kind) => RESTRICTION_CATALOG[kind].hidden)).toEqual([...HIDDEN_KINDS]);
    for (const kind of RESTRICTION_KINDS) expect(isHiddenKind(kind), kind).toBe(kind === "separate_board");
    expect(isHiddenKind("unknown_kind")).toBe(false);
    expect(RESTRICTION_KINDS.at(-1)).toBe("all");
    expect(RESTRICTION_KINDS.at(-2)).toBe("purchases");
  });

  it("правила наложения: молча и один; с сообщением игроку или вместе с другим видом — проблема", () => {
    expect(imposeProblem(["separate_board"], false)).toBeNull();
    expect(imposeProblem(["separate_board"], true)).toBe("Скрытое ограничение накладывается молча и отдельно от других");
    expect(imposeProblem(["separate_board", "promo_codes"], false)).toBe("Скрытое ограничение накладывается молча и отдельно от других");
    expect(imposeProblem(["leaderboard", "separate_board"], false)).toBe("Скрытое ограничение накладывается молча и отдельно от других");
    expect(imposeProblem(["leaderboard"], false)).toBeNull();
  });

  it("предпросмотр для держателя права: «Ничего: игрок не видит ни плашки, ни изменений в интерфейсе» — и при любом notify", async () => {
    const s = setup();
    const owner = await person(s, "700", "owner");
    const text = "Ничего: игрок не видит ни плашки, ни изменений в интерфейсе";
    expect(shownText("separate_board", null, "other", false)).toBe(text);
    expect(shownText("separate_board", null, "other", true)).toBe(text);
    const quiet = await s.service.preview(owner, { kinds: ["separate_board"], endsAt: null, reason: "leaderboard_cheat", notify: false }, NOW);
    expect(quiet).toEqual({ problem: null, shown: [{ kind: "separate_board", title: "Отдельная доска", text }] });
    const loud = await s.service.preview(owner, { kinds: ["separate_board"], endsAt: null, reason: "leaderboard_cheat", notify: true }, NOW);
    expect(loud.problem).toBe("Скрытое ограничение накладывается молча и отдельно от других");
  });

  it("игрок не видит вида: строка с notify = true, записанная в обход сервиса, ему не отдаётся", async () => {
    const s = setup();
    s.repository.restrict("a", "separate_board", { notify: true });
    s.repository.restrict("a", "promo_codes", { notify: true });
    s.repository.restrict("b", "separate_board", { notify: false });

    expect((await s.gate.visibleFor("a", NOW)).map((view) => view.kind)).toEqual(["promo_codes"]);
    expect(await s.gate.visibleFor("b", NOW)).toEqual([]);
  });

  it("каталог: владельцу — с видом, модератору и админу — без него", async () => {
    const s = setup();
    const [owner, moderator, admin] = [await person(s, "701", "owner"), await person(s, "702", "moderator"), await person(s, "703", "admin")];
    const visible = RESTRICTION_KINDS.filter((kind) => kind !== "separate_board");

    expect((await s.service.catalog(owner)).kinds.map((item) => item.kind)).toEqual([...RESTRICTION_KINDS]);
    expect((await s.service.catalog(owner)).kinds.find((item) => item.kind === "separate_board")).toMatchObject({ title: "Отдельная доска", hidden: true, silentAllowed: true });
    expect((await s.service.catalog(moderator)).kinds.map((item) => item.kind)).toEqual(visible);
    expect((await s.service.catalog(admin)).kinds.map((item) => item.kind)).toEqual(visible);
    expect((await s.service.catalog(moderator)).kinds.every((item) => item.hidden === false)).toBe(true);
  });

  it("предпросмотр модератором: тот же отказ, что на кривой черновик, — вид не выдаётся", async () => {
    const s = setup();
    const moderator = await person(s, "704", "moderator");
    const body = { kinds: ["separate_board" as RestrictionKind], endsAt: null, reason: "leaderboard_cheat" as const, notify: false };
    const refusal = s.service.preview(moderator, body, NOW);
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toThrow("Некорректный черновик ограничения");
  });

  it("владелец накладывает: строка, кеш сброшен, журнал `players.board.set` с прежними полями", async () => {
    const s = setup();
    const owner = await person(s, "705", "owner");
    const target = await person(s, "706");
    const views = await s.service.impose(owner, target.accountId, hidden({ comment: "подозрение на накрутку" }), NOW);

    expect(views.map((view) => [view.kind, view.state, view.notify, view.reasonTitle])).toEqual([["separate_board", "active", false, "Накрутка рейтинга"]]);
    expect(s.gate.published).toEqual([target.accountId]);
    expect((await s.gate.status(target.accountId, "separate_board", NOW))?.kind).toBe("separate_board");
    expect(s.roles.entries.at(-1)).toMatchObject({
      actorAccountId: owner.accountId,
      action: "players.board.set",
      target: target.accountId,
      after: { restrictions: [{ kind: "separate_board", reason: "leaderboard_cheat", comment: "подозрение на накрутку", notify: false }] },
    });
    // Игроку ни один вопрос о нём не отдаёт ничего, а его забеги по-прежнему рейтинговые — вид меняет только доску.
    expect(await s.gate.visibleFor(target.accountId, NOW)).toEqual([]);
  });

  it("повторное наложение заменяет действующее; журнал помнит замену под тем же действием", async () => {
    const s = setup();
    const owner = await person(s, "707", "owner");
    const target = await person(s, "708");
    await s.service.impose(owner, target.accountId, hidden(), NOW);
    await s.service.impose(owner, target.accountId, hidden({ endsAt: null }), new Date(NOW.getTime() + HOUR));

    const history = await s.service.history(owner, target.accountId, new Date(NOW.getTime() + HOUR));
    expect(history.map((view) => [view.kind, view.state])).toEqual([
      ["separate_board", "active"],
      ["separate_board", "replaced"],
    ]);
    expect(s.roles.entries.at(-1)).toMatchObject({ action: "players.board.set", before: { replaced: [{ kind: "separate_board" }] } });
  });

  it("модератор и админ: тот же ValidationError, что на кривое тело; в базу, журнал и кеш — ничего", async () => {
    const s = setup();
    const target = await person(s, "709");
    for (const role of ["moderator", "admin"] as const) {
      const staff = await person(s, role === "moderator" ? "710" : "711", role);
      const refusal = s.service.impose(staff, target.accountId, hidden(), NOW);
      await expect(refusal, role).rejects.toBeInstanceOf(ValidationError);
      await expect(refusal, role).rejects.toThrow(MALFORMED);
    }
    expect(s.repository.rows).toEqual([]);
    expect(s.roles.entries).toEqual([]);
    expect(s.gate.published).toEqual([]);
  });

  it("смешанный набор и сообщение игроку владельцу отказывают словами; себя ограничить нельзя", async () => {
    const s = setup();
    const owner = await person(s, "712", "owner");
    const target = await person(s, "713");
    await expect(s.service.impose(owner, target.accountId, hidden({ kinds: ["separate_board", "promo_codes"] }), NOW)).rejects.toThrow("Скрытое ограничение накладывается молча и отдельно от других");
    await expect(s.service.impose(owner, target.accountId, hidden({ notify: true }), NOW)).rejects.toThrow("Скрытое ограничение накладывается молча и отдельно от других");
    await expect(s.service.impose(owner, owner.accountId, hidden(), NOW)).rejects.toThrow("Ограничить себя нельзя");
    expect(s.repository.rows).toEqual([]);
  });

  it("снятие: модератору строки как будто нет, владелец снимает с `players.board.unset`; повтор — «нет такого»", async () => {
    const s = setup();
    const [owner, moderator] = [await person(s, "714", "owner"), await person(s, "715", "moderator")];
    const target = await person(s, "716");
    const [row] = await s.service.impose(owner, target.accountId, hidden(), NOW);
    const id = row?.restrictionId ?? "";

    const refused: unknown = await s.service.lift(moderator, id, "хочу", NOW).catch((error: unknown) => error);
    const unknown: unknown = await s.service.lift(moderator, "00000000-0000-4000-8000-000000000999", "хочу", NOW).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RestrictionNotFoundError);
    // Тот же ответ, что на несуществующее.
    expect(refused).toEqual(unknown);
    expect(s.repository.rows[0]?.liftedAt).toBeNull();

    const lifted = await s.service.lift(owner, id, "разобрались", new Date(NOW.getTime() + HOUR));
    expect(lifted).toMatchObject({ kind: "separate_board", state: "lifted", liftComment: "разобрались" });
    expect(s.roles.entries.map((entry) => entry.action)).toEqual(["players.board.set", "players.board.unset"]);
    expect(s.roles.entries.at(-1)).toMatchObject({ target: target.accountId, before: { kind: "separate_board" }, after: { comment: "разобрались" } });
    await expect(s.service.lift(owner, id, "ещё раз", new Date(NOW.getTime() + 2 * HOUR))).rejects.toBeInstanceOf(RestrictionNotFoundError);
  });

  it("история: строка вида — владельцу, модератору её нет; прочие виды видны обоим", async () => {
    const s = setup();
    const [owner, moderator] = [await person(s, "717", "owner"), await person(s, "718", "moderator")];
    const target = await person(s, "719");
    await s.service.impose(owner, target.accountId, hidden(), NOW);
    await s.service.impose(owner, target.accountId, input(), new Date(NOW.getTime() + HOUR));

    const at = new Date(NOW.getTime() + 2 * HOUR);
    expect((await s.service.history(owner, target.accountId, at)).map((view) => view.kind)).toEqual(["promo_codes", "separate_board"]);
    expect((await s.service.history(moderator, target.accountId, at)).map((view) => view.kind)).toEqual(["promo_codes"]);
  });

  it("слушатели получают вид в `kinds`; истёкшее снимает задача и зовёт `emitSettled`", async () => {
    const s = setup();
    const owner = await person(s, "720", "owner");
    const target = await person(s, "721");
    const imposed: string[][] = [];
    const settled: string[][] = [];
    s.hooks.onImposed("доски", async (change) => void imposed.push([...change.kinds]));
    s.hooks.onSettled("доски", async (change) => void settled.push([...change.kinds]));

    await s.service.impose(owner, target.accountId, hidden({ endsAt: new Date(NOW.getTime() + DAY).toISOString() }), NOW);
    expect(imposed).toEqual([["separate_board"]]);

    expect(await s.service.settleDue(new Date(NOW.getTime() + DAY + 60_000))).toBe(1);
    expect(settled).toEqual([["separate_board"]]);
    expect(s.repository.rows[0]?.settledAt).not.toBeNull();
    expect(await s.service.settleDue(new Date(NOW.getTime() + DAY + 120_000))).toBe(0);
  });

  it("право: есть у владельца и ни у одной другой роли", () => {
    expect(PERMISSIONS).toContain("players.board.restrict");
    expect(ROLE_PERMISSIONS.owner).toContain("players.board.restrict");
    for (const role of ROLES.filter((item) => item !== "owner")) expect(ROLE_PERMISSIONS[role], role).not.toContain("players.board.restrict");
  });

  it("журнал аудита: строки `players.board.*` — только с правом вида; остальные видны всем, у кого `audit.view`", async () => {
    const s = setup();
    const [owner, admin] = [await person(s, "722", "owner"), await person(s, "723", "admin")];
    const target = await person(s, "724");
    const [row] = await s.service.impose(owner, target.accountId, hidden(), NOW);
    await s.service.impose(owner, target.accountId, input(), new Date(NOW.getTime() + HOUR));
    await s.service.lift(owner, row?.restrictionId ?? "", "достаточно", new Date(NOW.getTime() + 2 * HOUR));
    const rolesService = new RolesService(config(), s.roles, s.accounts);
    const query = { limit: 10, before: null, actions: [], actorAccountId: null, target: null };

    expect((await rolesService.auditPage(owner, query)).map((entry) => entry.action)).toEqual(["players.board.unset", "players.restrict", "players.board.set"]);
    expect((await rolesService.auditPage(admin, query)).map((entry) => entry.action)).toEqual(["players.restrict"]);
    expect((await rolesService.auditPage(admin, { ...query, actions: ["players.board."] })).map((entry) => entry.action)).toEqual([]);
  });

  it("журнал аудита: страница без права набирается из следующих записей, а не обрывается на скрытых", async () => {
    const s = setup();
    const owner = await person(s, "725", "owner");
    const admin = await person(s, "726", "admin");
    const rolesService = new RolesService(config(), s.roles, s.accounts);
    await s.roles.append({ actorAccountId: owner.accountId, action: "settings.save", target: "a" });
    for (let index = 0; index < 5; index += 1) await s.roles.append({ actorAccountId: owner.accountId, action: "players.board.set", target: `t${String(index)}` });
    await s.roles.append({ actorAccountId: owner.accountId, action: "settings.save", target: "b" });

    const page = await rolesService.auditPage(admin, { limit: 2, before: null, actions: [], actorAccountId: null, target: null });
    expect(page.map((entry) => [entry.action, entry.target])).toEqual([
      ["settings.save", "b"],
      ["settings.save", "a"],
    ]);
  });
});

describe("последствия по сроку", () => {
  it("истёкшая блокировка снимается задачей; при другой действующей блокировке — остаётся", async () => {
    const s = setup();
    const owner = await person(s, OWNER_ID);
    const short = await person(s, "520");
    const twice = await person(s, "521");
    await s.service.impose(owner, short.accountId, input({ kinds: ["all"], endsAt: new Date(NOW.getTime() + DAY).toISOString() }), NOW);
    await s.service.impose(owner, twice.accountId, input({ kinds: ["all"], endsAt: new Date(NOW.getTime() + DAY).toISOString() }), NOW);
    // Вторая блокировка того же вида заменяет первую — заменённая уже снята без последствий.
    await s.service.impose(owner, twice.accountId, input({ kinds: ["all"], endsAt: null }), new Date(NOW.getTime() + HOUR));

    const later = new Date(NOW.getTime() + DAY + 60_000);
    expect(await s.service.settleDue(later)).toBe(1);
    expect((await s.accounts.byId(short.accountId))?.bannedAt).toBeNull();
    expect((await s.accounts.byId(twice.accountId))?.bannedAt).not.toBeNull();
    expect(await s.service.settleDue(later)).toBe(0);
  });

  it("последствия в чужом модуле: наложение зовёт слушателя и не отменяется его сбоем; не снялось — не сведено, задача повторит", async () => {
    const s = setup();
    const moderator = await person(s, "522", "moderator");
    const target = await person(s, "523");
    const imposed: string[][] = [];
    s.hooks.onImposed("сломанный", async () => {
      throw new Error("Redis недоступен");
    });
    s.hooks.onImposed("рейтинг", async (change) => {
      imposed.push([...change.kinds]);
    });
    let down = true;
    const settled: string[] = [];
    s.hooks.onSettled("рейтинг", async (change) => {
      if (down) throw new Error("Redis недоступен");
      settled.push(change.accountId);
    });

    const [row] = await s.service.impose(moderator, target.accountId, input({ kinds: ["ad_rewards", "promo_codes"] }), NOW);
    expect(imposed).toEqual([["ad_rewards", "promo_codes"]]);

    // Снятие записано, даже если последствия не снялись.
    const lifted = await s.service.lift(moderator, row?.restrictionId ?? "", "ошиблись", new Date(NOW.getTime() + HOUR));
    expect(lifted.state).toBe("lifted");
    expect(s.repository.rows.find((item) => item.restrictionId === row?.restrictionId)?.settledAt).toBeNull();

    down = false;
    expect(await s.service.settleDue(new Date(NOW.getTime() + 2 * HOUR))).toBe(1);
    expect(settled).toEqual([target.accountId]);
    expect(await s.service.settleDue(new Date(NOW.getTime() + 3 * HOUR))).toBe(0);
  });

  it("задача — под локом: занят у соседа — проход пропускается", async () => {
    const s = setup();
    const taken = { set: async () => null, eval: async () => 0 } as unknown as Redis;
    const settler = new RestrictionsSettler(config(), taken, s.service);
    expect(await settler.tick(NOW)).toBeNull();
    const free = { set: async () => "OK", eval: async () => 1 } as unknown as Redis;
    expect(await new RestrictionsSettler(config(), free, s.service).tick(NOW)).toBe(0);
  });
});

describe("свои ограничения по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без входа — 401; с входом — только то, о чём игроку сообщили", async () => {
    const s = setup();
    const me = await person(s, "530");
    s.repository.restrict(me.accountId, "friend_gifts", { endsAt: new Date(Date.now() + DAY), reason: "multiaccount" });
    s.repository.restrict(me.accountId, "ad_rewards", { notify: false });
    @Module({
      controllers: [RestrictionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: AccountRestrictions, useValue: s.gate },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/me/restrictions" })).statusCode).toBe(401);
    const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: "530" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const mine = await app.inject({ method: "GET", url: "/api/v1/me/restrictions", headers: { authorization: `Bearer ${token}` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.restrictions).toEqual([expect.objectContaining({ kind: "friend_gifts", title: "Подарки друзьям", until: expect.stringMatching(/^до \d+ [а-я]+, \d\d:\d\d МСК$/), reason: "Награды с нескольких аккаунтов одного человека" })]);
  });
});

describe("ограничения в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("каталог, наложение, история и снятие; кривое тело — 400, без права — 403, снятое второй раз — 404", async () => {
    const s = setup();
    const store = new MemoryAdminSessionStore();
    // Отзыв сессий при блокировке проверяет тест карточки игрока; здесь — путь запроса до сервиса.
    const players = { restrict: async (actor: AccountRef, accountId: string, body: Parameters<RestrictionsService["impose"]>[2]) => ({ restrictions: await s.service.impose(actor, accountId, body), revokedSessions: 0 }) };
    @Module({
      controllers: [AdminRestrictionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: s.accounts },
        { provide: ROLES_REPOSITORY, useValue: s.roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: RestrictionsService, useValue: s.service },
        { provide: AdminPlayersService, useValue: players },
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const moderator = await person(s, "540", "moderator");
    const designer = await person(s, "541", "game_designer");
    const target = await person(s, "542");
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    await store.put(hashSessionToken("gd"), { ...designer, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=mod`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const base = `/api/v1/admin/players/${target.accountId}/restrictions`;
    const body = { kinds: ["ad_rewards"], endsAt: new Date(Date.now() + DAY).toISOString(), reason: "ad_abuse", comment: null, notify: true };

    const catalog = await app.inject({ method: "GET", url: "/api/v1/admin/restrictions/catalog", headers });
    expect(catalog.statusCode).toBe(200);
    // Модератору скрытого вида в каталоге нет (T-0112).
    expect(catalog.json().data.kinds.map((item: { kind: string }) => item.kind)).toEqual(RESTRICTION_KINDS.filter((kind) => !RESTRICTION_CATALOG[kind].hidden));

    const preview = await app.inject({ method: "POST", url: "/api/v1/admin/restrictions/preview", headers, payload: { kinds: ["ad_rewards"], endsAt: null, reason: "ad_abuse", notify: true } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.shown[0].text).toBe("Награды за рекламу — закрыто бессрочно. Причина: Неестественные просмотры рекламы");
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/restrictions/preview", headers, payload: { kinds: [], endsAt: null, reason: "ad_abuse", notify: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/restrictions/preview", headers: { ...headers, cookie: `${ADMIN_SESSION_COOKIE}=gd` }, payload: { kinds: ["ad_rewards"], endsAt: null, reason: "ad_abuse", notify: true } })).statusCode).toBe(403);

    expect((await app.inject({ method: "POST", url: base, headers: { ...headers, cookie: `${ADMIN_SESSION_COOKIE}=gd` }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: base, headers, payload: { ...body, kinds: ["ad_rewards", "ad_rewards"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: base, headers, payload: { ...body, reason: "просто так" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/players/not-a-uuid/restrictions", headers, payload: body })).statusCode).toBe(400);

    const imposed = await app.inject({ method: "POST", url: base, headers, payload: body });
    expect(imposed.statusCode).toBe(201);
    const [created] = imposed.json().data.restrictions as { restrictionId: string; kind: string; state: string }[];
    expect(created).toMatchObject({ kind: "ad_rewards", state: "active" });

    const history = await app.inject({ method: "GET", url: base, headers });
    expect(history.json().data.restrictions).toHaveLength(1);

    const lift = `/api/v1/admin/restrictions/${created?.restrictionId ?? ""}/lift`;
    expect((await app.inject({ method: "POST", url: lift, headers, payload: { comment: "" } })).statusCode).toBe(400);
    const lifted = await app.inject({ method: "POST", url: lift, headers, payload: { comment: "ошиблись игроком" } });
    expect(lifted.json().data).toMatchObject({ state: "lifted", liftComment: "ошиблись игроком" });
    const again = await app.inject({ method: "POST", url: lift, headers, payload: { comment: "ещё раз" } });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("restriction_not_found");
  });
});

describe("скрытое ограничение по HTTP (T-0112)", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("игроку «мои ограничения» отдают пусто, даже если строка вида записана с notify = true", async () => {
    const s = setup();
    const me = await person(s, "800");
    s.repository.restrict(me.accountId, "separate_board", { notify: true });
    @Module({
      controllers: [RestrictionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: AccountRestrictions, useValue: s.gate },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: "800" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const mine = await app.inject({ method: "GET", url: "/api/v1/me/restrictions", headers: { authorization: `Bearer ${token}` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.restrictions).toEqual([]);
  });

  it("в панели: каталог, предпросмотр и наложение — владельцу с видом, модератору — как на неизвестное; история и снятие по праву", async () => {
    const s = setup();
    const store = new MemoryAdminSessionStore();
    const players = { restrict: async (actor: AccountRef, accountId: string, body: Parameters<RestrictionsService["impose"]>[2]) => ({ restrictions: await s.service.impose(actor, accountId, body), revokedSessions: 0 }) };
    @Module({
      controllers: [AdminRestrictionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: s.accounts },
        { provide: ROLES_REPOSITORY, useValue: s.roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: RestrictionsService, useValue: s.service },
        { provide: AdminPlayersService, useValue: players },
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const owner = await person(s, "801", "owner");
    const moderator = await person(s, "802", "moderator");
    const target = await person(s, "803");
    await store.put(hashSessionToken("own"), { ...owner, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const as = (who: "own" | "mod") => ({ cookie: `${ADMIN_SESSION_COOKIE}=${who}`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
    const base = `/api/v1/admin/players/${target.accountId}/restrictions`;
    const draft = { kinds: ["separate_board"], endsAt: null, reason: "leaderboard_cheat", notify: false };
    const body = { ...draft, comment: "проверка", endsAt: new Date(Date.now() + DAY).toISOString() };
    const kindsOf = (response: { json(): { data: { kinds: { kind: string }[] } } }) => response.json().data.kinds.map((item) => item.kind);

    const ownerCatalog = await app.inject({ method: "GET", url: "/api/v1/admin/restrictions/catalog", headers: as("own") });
    const modCatalog = await app.inject({ method: "GET", url: "/api/v1/admin/restrictions/catalog", headers: as("mod") });
    expect(kindsOf(ownerCatalog)).toContain("separate_board");
    expect(kindsOf(modCatalog)).not.toContain("separate_board");

    // Предпросмотр: владельцу — текст, модератору — тот же отказ, что на кривое тело.
    const ownerPreview = await app.inject({ method: "POST", url: "/api/v1/admin/restrictions/preview", headers: as("own"), payload: draft });
    expect(ownerPreview.statusCode).toBe(200);
    expect(ownerPreview.json().data.shown[0].text).toBe("Ничего: игрок не видит ни плашки, ни изменений в интерфейсе");
    const modPreview = await app.inject({ method: "POST", url: "/api/v1/admin/restrictions/preview", headers: as("mod"), payload: draft });
    const badPreview = await app.inject({ method: "POST", url: "/api/v1/admin/restrictions/preview", headers: as("mod"), payload: { ...draft, kinds: [] } });
    expect(modPreview.statusCode).toBe(400);
    expect(modPreview.json()).toEqual(badPreview.json());

    // Наложение: модератору — 400, как на кривое тело; ничего не записано.
    const modImpose = await app.inject({ method: "POST", url: base, headers: as("mod"), payload: body });
    const badImpose = await app.inject({ method: "POST", url: base, headers: as("mod"), payload: { ...body, kinds: ["ad_rewards", "ad_rewards"] } });
    expect(modImpose.statusCode).toBe(400);
    expect(modImpose.json()).toEqual(badImpose.json());
    expect(s.repository.rows).toEqual([]);

    const imposed = await app.inject({ method: "POST", url: base, headers: as("own"), payload: body });
    expect(imposed.statusCode).toBe(201);
    const [created] = imposed.json().data.restrictions as { restrictionId: string; kind: string; notify: boolean }[];
    expect(created).toMatchObject({ kind: "separate_board", notify: false });

    // История и снятие.
    expect((await app.inject({ method: "GET", url: base, headers: as("own") })).json().data.restrictions).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: base, headers: as("mod") })).json().data.restrictions).toEqual([]);
    const lift = `/api/v1/admin/restrictions/${created?.restrictionId ?? ""}/lift`;
    const modLift = await app.inject({ method: "POST", url: lift, headers: as("mod"), payload: { comment: "хочу" } });
    expect(modLift.statusCode).toBe(404);
    expect(modLift.json().error.code).toBe("restriction_not_found");
    const ownerLift = await app.inject({ method: "POST", url: lift, headers: as("own"), payload: { comment: "разобрались" } });
    expect(ownerLift.statusCode).toBe(201);
    expect(ownerLift.json().data).toMatchObject({ kind: "separate_board", state: "lifted" });
  });
});

/**
 * Контракт каталога: каждый вид отказывает в своём модуле. Новый вид без
 * проверки там, где его обещает каталог, роняет этот тест, — иначе панель
 * накладывала бы ограничение, которое ничего не закрывает. Как отказывает
 * модуль, проверяют тесты самих модулей.
 */
describe("контракт каталога", () => {
  const MODULES = fileURLToPath(new URL("../src/modules", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
    });
  }

  it.each(RESTRICTION_KINDS.filter((kind) => kind !== "all"))("«%s» проверяется в модулях каталога", (kind) => {
    const modules = RESTRICTION_CATALOG[kind].checkedIn.split(",").map((name) => name.trim());
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      const code = sources(join(MODULES, module)).join("\n");
      expect(code, `${module} не спрашивает AccountRestrictions`).toContain("AccountRestrictions");
      expect(code, `${module} не проверяет «${kind}»`).toMatch(new RegExp(`"${kind}"`));
    }
  });

  it("блокировка целиком отказывает при входе — по отметке аккаунта", () => {
    const auth = sources(join(MODULES, "auth")).join("\n");
    expect(RESTRICTION_CATALOG.all.checkedIn).toBe("auth");
    expect(auth).toContain("bannedAt !== null");
  });
});
