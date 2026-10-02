import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaConversionsRepository } from "../src/modules/ad-conversions/conversions.repository.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository, type RegistrationOn } from "../src/modules/links/links.repository.js";

/**
 * Конверсии закупленной рекламы на живом Postgres (WP43, Р86): регистрация
 * и покупки выводятся из первого касания, забегов и оплат; повтор прохода
 * ничего не задваивает; старый игрок, аккаунт команды, возврат и тестовая
 * оплата сети не отдаются. Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;

describe.skipIf(DATABASE_URL === "")("конверсии на живом Postgres", () => {
  let prisma: PrismaClient;
  let conversions: PrismaConversionsRepository;
  let links: PrismaLinksRepository;
  let accounts: PrismaAccountRepository;
  let sessions: PrismaSessionsRepository;
  const linkCodes: string[] = [];

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    conversions = new PrismaConversionsRepository(prisma);
    links = new PrismaLinksRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
    sessions = new PrismaSessionsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.link.deleteMany({ where: { code: { in: linkCodes } } });
    await prisma.$disconnect();
  });

  async function adsgramLink(registrationOn: RegistrationOn = "first_run"): Promise<string> {
    const code = newLinkCode();
    linkCodes.push(code);
    await links.create({ code, platform: "telegram", campaign: "ag-test", source: "adsgram", medium: null, note: null, createdBy: null, network: "adsgram", registrationOn });
    return code;
  }

  /** Игрок, пришедший по клику: клик пять минут назад, аккаунт — сейчас, первая сессия — по клику. */
  async function playerFromClick(code: string, params: Record<string, string> | null = { record: "rec123", campaign: "55" }) {
    const clickId = newClickId();
    await links.recordClick({
      clickId,
      linkCode: code,
      at: new Date(Date.now() - 5 * MINUTE),
      utm: { source: null, medium: null, campaign: null, content: null, term: null },
      refererHost: null,
      deviceClass: "mobile",
      ipPrefix: null,
      language: null,
      networkParams: params,
    });
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 99_000_000)), displayName: "Из рекламы", username: null, photoUrl: null },
      Date.now(),
    );
    await sessions.record({
      sessionId: randomUUID(),
      accountId: account.accountId,
      platform: "telegram",
      place: "miniapp",
      startKind: "click",
      startParam: `c-${clickId}`,
      startRef: clickId,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: null,
      startedAt: new Date().toISOString(),
    });
    return { clickId, accountId: account.accountId, telegramId: account.platformUserId };
  }

  async function finishedRun(accountId: string, survivalSec: number, patch: { cheats?: boolean } = {}) {
    await prisma.run.create({
      data: {
        runId: `ag-${randomUUID()}`,
        accountId,
        status: "finished",
        difficulty: "normal",
        startingWeaponId: "spark",
        contentHash: "abc",
        startedAt: new Date(Date.now() - survivalSec * 1000),
        finishedAt: new Date(),
        outcome: "died",
        survivalSec,
        cheats: patch.cheats ?? false,
        verdictReasons: [],
      },
    });
  }

  async function purchase(accountId: string, paidMinutesAgo: number, patch: { mode?: "live" | "test"; refunded?: boolean } = {}) {
    const purchaseId = randomUUID();
    const paidAt = new Date(Date.now() - paidMinutesAgo * MINUTE);
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "shop_item",
        sku: "gems_small",
        priceStars: 50,
        chargedStars: 50,
        mode: patch.mode ?? "live",
        status: patch.refunded === true ? "refunded" : "paid",
        invoicedAt: paidAt,
        paidAt,
        ...(patch.refunded === true ? { refundRequestedAt: new Date(), refundedAt: new Date() } : {}),
      },
    });
    return purchaseId;
  }

  const ofAccount = (accountId: string) => prisma.adConversion.findMany({ where: { accountId }, orderBy: { goal: "asc" } });

  it("регистрация — после первого засчитанного забега; короткий и с читами не считаются; повтор прохода не задваивает", async () => {
    const code = await adsgramLink();
    const player = await playerFromClick(code);

    await finishedRun(player.accountId, 12);
    await finishedRun(player.accountId, 400, { cheats: true });
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toEqual([]);

    await finishedRun(player.accountId, 95);
    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goal: 1, status: "pending", network: "adsgram", linkCode: code, clickId: player.clickId, purchaseId: null });

    const due = (await conversions.due(new Date(), 500)).find((row) => row.conversionId === rows[0]?.conversionId);
    expect(due).toMatchObject({ goal: 1, attempts: 0, params: { record: "rec123", campaign: "55" }, telegramId: player.telegramId });
  });

  it("ссылка «при первом запуске» — регистрация без забега", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toMatchObject([{ goal: 1, status: "pending" }]);
  });

  it("старый игрок, открывший игру по рекламе, — не конверсия сети; аккаунт команды — пропущен", async () => {
    const code = await adsgramLink("launch");
    const old = await playerFromClick(code);
    await prisma.account.update({ where: { accountId: old.accountId }, data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE) } });
    const team = await playerFromClick(code);
    await prisma.accountRole.create({ data: { accountId: team.accountId, role: "marketer" } });

    await conversions.sweep(new Date());
    expect(await ofAccount(old.accountId)).toEqual([]);
    const [teamRow] = await ofAccount(team.accountId);
    expect(teamRow).toMatchObject({ goal: 1, status: "skipped", reason: "team" });
    // Аккаунт команды можно отправить руками — проверить связку с кабинетом.
    expect(await conversions.requeue(code, teamRow?.conversionId ?? "", new Date())).toMatchObject({ status: "pending", reason: null });
  });

  it("покупки: первая — цель 2, следующие — 3; возврат, тестовая и неотлежавшаяся не уходят", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const first = await purchase(player.accountId, 40);
    await purchase(player.accountId, 35, { refunded: true });
    await purchase(player.accountId, 30, { mode: "test" });
    const second = await purchase(player.accountId, 20);
    const fresh = await purchase(player.accountId, 2);

    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = (await ofAccount(player.accountId)).filter((row) => row.goal !== 1);
    expect(rows.map((row) => [row.goal, row.purchaseId])).toEqual([
      [2, first],
      [3, second],
    ]);

    // Через десять минут отлежится и свежая — повторной.
    await conversions.sweep(new Date(Date.now() + 15 * MINUTE));
    expect((await ofAccount(player.accountId)).find((row) => row.purchaseId === fresh)).toMatchObject({ goal: 3 });
  });

  it("журнал, счёт по ссылке, отправка и повтор неотправленной", async () => {
    const code = await adsgramLink("launch");
    const sent = await playerFromClick(code);
    const failed = await playerFromClick(code);
    await conversions.sweep(new Date());
    const [sentRow] = await ofAccount(sent.accountId);
    const [failedRow] = await ofAccount(failed.accountId);
    if (sentRow === undefined || failedRow === undefined) throw new Error("конверсии не найдены");

    await conversions.markSent(sentRow.conversionId, 200, new Date());
    await conversions.markFailed(failedRow.conversionId, 8, null, 400, "ответ 400: invalid record");

    const summary = (await conversions.summaries([code])).get(code);
    expect(summary?.[1]).toEqual({ pending: 0, sent: 1, failed: 1, skipped: 0 });
    const journal = await conversions.journal(code, null, 50);
    expect(journal.map((row) => row.status).sort()).toEqual(["failed", "sent"]);
    // Обе строки записал один проход с одним временем — страница по одной
    // строке не теряет вторую на стыке.
    const [first] = await conversions.journal(code, null, 1);
    if (first === undefined) throw new Error("журнал пуст");
    const rest = await conversions.journal(code, { createdAt: first.createdAt, conversionId: first.conversionId }, 1);
    expect([first, ...rest].map((row) => row.conversionId).sort()).toEqual([sentRow.conversionId, failedRow.conversionId].sort());

    expect(await conversions.requeue(code, sentRow.conversionId, new Date())).toBeNull();
    expect(await conversions.requeue(code, failedRow.conversionId, new Date())).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    // Чужой ссылкой повторить нельзя.
    expect(await conversions.requeue(newLinkCode(), failedRow.conversionId, new Date())).toBeNull();
    // Без меток сети повтор пропустился бы снова — его не ставят.
    await conversions.skip(failedRow.conversionId, "no_macros");
    expect(await conversions.requeue(code, failedRow.conversionId, new Date())).toBeNull();
  });

  it("макросы кликов старше окна обнуляются", async () => {
    const code = await adsgramLink();
    const player = await playerFromClick(code);
    await prisma.linkClick.update({ where: { clickId: player.clickId }, data: { at: new Date(Date.now() - 40 * 24 * 60 * MINUTE) } });
    await conversions.purgeParams(new Date(), 500);
    expect((await prisma.linkClick.findUniqueOrThrow({ where: { clickId: player.clickId } })).networkParams).toBeNull();
  });
});
