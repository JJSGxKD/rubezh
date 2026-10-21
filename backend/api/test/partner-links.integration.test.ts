import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { SessionRecorder, sessionOf } from "../src/modules/attribution/session-recorder.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository } from "../src/modules/links/links.repository.js";
import { PartnerLinkBinder } from "../src/modules/partners/partner-links.js";
import { PrismaPartnerLinksSource } from "../src/modules/partners/partner-links.repository.js";
import type { PartnerRow } from "../src/modules/partners/partner-rules.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { PrismaReferralsRepository } from "../src/modules/referrals/referrals.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Привязка игрока по ссылке партнёра на живом Postgres (T-0067; адрес —
 * TEST_DATABASE_URL, без него пропуск). Redis тесту не нужен: запись сессии
 * идёт напрямую, как при недоступной очереди, а задание очереди — вызовом
 * `process`. Слот источника один на рефералку, коды и ссылки, и под гонкой
 * сессий — одна привязка.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const DAY = 86_400_000;
const LONG_AGO = new Date(Date.UTC(2020, 0, 1));
const utm = { source: null, medium: null, campaign: null, content: null, term: null };

describe.skipIf(DATABASE_URL === "")("ссылки партнёра на живом Postgres", () => {
  let prisma: PrismaClient;
  let links: PrismaLinksRepository;
  let partners: PrismaPartnersRepository;
  let referrals: PrismaReferralsRepository;
  let accounts: PrismaAccountRepository;
  let sessions: PrismaSessionsRepository;
  let recorder: SessionRecorder;

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 8);
    links = new PrismaLinksRepository(prisma);
    partners = new PrismaPartnersRepository(prisma);
    referrals = new PrismaReferralsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
    sessions = new PrismaSessionsRepository(prisma);
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    // Окно повторов в Redis здесь ни при чём: каждый вход — новый запуск.
    recorder = new SessionRecorder(config, new AuthHooks(), sessions, { claim: async () => true }, new PartnerLinkBinder(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Партнёры теста датируются давно: соседние интеграционные тесты ищут своих партнёров в списке
   * «пятьсот новейших», и строки этого файла, заведённые «сейчас», на общей базе вытеснили бы их
   * за границу списка.
   */
  async function partner(name = "Канал", terms: Partial<PartnerRow> = {}): Promise<string> {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name, contact: null, note: null, createdBy: randomUUID(), createdAt: LONG_AGO, updatedAt: LONG_AGO, ...terms });
    return partnerId;
  }

  async function link(partnerId: string | null, patch: { network?: "adsgram" | null; campaign?: string } = {}): Promise<string> {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: patch.campaign ?? "channel-post", source: null, medium: null, note: null, createdBy: null, network: patch.network ?? null, registrationOn: "first_run", partnerId });
    return code;
  }

  async function click(code: string): Promise<string> {
    const clickId = newClickId();
    await links.recordClick({ clickId, linkCode: code, at: new Date(), utm, refererHost: "t.me", deviceClass: "mobile", ipPrefix: "198.51.100.0/24", language: "ru-RU", networkParams: null });
    return clickId;
  }

  /** Аккаунт заведён `ageDays` суток назад. */
  async function account(ageDays = 0): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e12)), displayName: "Новичок", username: null, photoUrl: null }, Date.now());
    if (ageDays > 0) await prisma.$executeRaw`UPDATE account SET created_at = ${new Date(Date.now() - ageDays * DAY)} WHERE account_id = ${created.accountId}::uuid`;
    return created.accountId;
  }

  function entry(accountId: string, startParam: string | null, at = new Date()): LoginEvent {
    return {
      accountId,
      platform: "telegram",
      place: "miniapp",
      startParam: parseStartParam(startParam),
      created: false,
      at,
      ip: "198.51.100.7",
      userAgent: "Mozilla/5.0 (Linux; Android 14)",
      client: { platform: "android", version: "8.0" },
      reason: "launch",
    };
  }

  const bindings = (accountId: string) => prisma.partnerBinding.findMany({ where: { accountId } });

  it("вход новым аккаунтом по клику ссылки партнёра — привязка с кодом ссылки и временем входа", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const me = await account();
    const at = new Date(Date.now() - 1_000);

    await recorder.record(entry(me, `c-${await click(code)}`, at));

    expect(await bindings(me)).toEqual([{ accountId: me, partnerId, campaignId: null, linkCode: code, boundAt: at }]);
    expect(await partners.bindingOf(me)).toMatchObject({ partnerId, name: "Канал", campaignTitle: null, code: null });
  });

  it("тот же вход по прямой ссылке l-<код> — привязка", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const me = await account();

    await recorder.record(entry(me, `l-${code}`));

    expect(await bindings(me)).toMatchObject([{ accountId: me, partnerId, linkCode: code, campaignId: null }]);
  });

  it("ссылка закупки партнёра в AdsGram привязывает так же", async () => {
    const partnerId = await partner();
    const code = await link(partnerId, { network: "adsgram" });
    const me = await account();

    await recorder.record(entry(me, `c-${await click(code)}`));

    expect(await bindings(me)).toMatchObject([{ partnerId, linkCode: code }]);
  });

  it("аккаунт уже привязан к рефереру — привязки по ссылке нет; к другому партнёру или к коду — тоже", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const referrer = await account();

    const invited = await account();
    expect(await referrals.bind(invited, referrer, "bound", null)).toBe(true);
    await recorder.record(entry(invited, `l-${code}`));
    expect(await bindings(invited)).toEqual([]);

    // Отклонённая антифродом привязка друга слот тоже занимает.
    const suspicious = await account();
    expect(await referrals.bind(suspicious, referrer, "rejected", "same_network")).toBe(true);
    await recorder.record(entry(suspicious, `l-${code}`));
    expect(await bindings(suspicious)).toEqual([]);

    // Игрок, которого раньше привёл код другого партнёра, остаётся за ним.
    const other = await partner("Другой");
    const claimed = await account();
    await prisma.$executeRaw`INSERT INTO partner_binding (account_id, partner_id, bound_at) VALUES (${claimed}::uuid, ${other}::uuid, now())`;
    await recorder.record(entry(claimed, `l-${code}`));
    expect(await bindings(claimed)).toMatchObject([{ partnerId: other, linkCode: null }]);
  });

  it("две сессии одновременно — одна привязка, у двух ссылок разных партнёров тоже", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const me = await account();
    const clickId = await click(code);
    await Promise.all(Array.from({ length: 6 }, (_, index) => recorder.record(entry(me, index % 2 === 0 ? `c-${clickId}` : `l-${code}`))));
    expect(await bindings(me)).toMatchObject([{ partnerId, linkCode: code }]);
    expect(await prisma.accountSession.count({ where: { accountId: me } })).toBe(6);

    const first = await partner("Первый");
    const second = await partner("Второй");
    const firstCode = await link(first);
    const secondCode = await link(second);
    const racing = await account();
    await Promise.all([...Array.from({ length: 3 }, () => recorder.record(entry(racing, `l-${firstCode}`))), ...Array.from({ length: 3 }, () => recorder.record(entry(racing, `l-${secondCode}`)))]);
    const rows = await bindings(racing);
    expect(rows).toHaveLength(1);
    expect([first, second]).toContain(rows[0]?.partnerId);
  });

  it("повтор задания очереди — одна привязка и одна сессия", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const me = await account();
    const session = sessionOf(entry(me, `l-${code}`));

    await recorder.process({ data: { session } });
    await recorder.process({ data: { session } });

    expect(await bindings(me)).toMatchObject([{ partnerId, linkCode: code }]);
    expect(await prisma.accountSession.count({ where: { accountId: me } })).toBe(1);
  });

  it("задание повторено после того, как сессия уже записана, а привязка не успела, — привязка доводится", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const me = await account();
    const session = sessionOf(entry(me, `l-${code}`));

    // Прошлая попытка записала сессию и упала на привязке.
    expect(await sessions.record(session)).toBe("recorded");
    expect(await bindings(me)).toEqual([]);

    await recorder.process({ data: { session } });
    expect(await bindings(me)).toMatchObject([{ partnerId, linkCode: code }]);
  });

  it("приостановленный, заявка и отклонённый партнёры не привязывают и слот не занимают", async () => {
    for (const status of ["paused", "applied", "rejected"] as const) {
      const code = await link(await partner(status, { status }));
      const me = await account();
      await recorder.record(entry(me, `l-${code}`));
      expect(await bindings(me), status).toEqual([]);

      // Слот свободен: активный партнёр потом привяжет.
      const active = await partner("Активный");
      const activeCode = await link(active);
      await recorder.record(entry(me, `l-${activeCode}`));
      expect(await bindings(me), status).toMatchObject([{ partnerId: active }]);
    }
  });

  it("окно привязки: аккаунт 6 суток — привязка, 8 суток — нет", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const young = await account(6);
    const old = await account(8);

    await recorder.record(entry(young, `l-${code}`));
    await recorder.record(entry(old, `l-${code}`));

    expect(await bindings(young)).toHaveLength(1);
    expect(await bindings(old)).toEqual([]);
  });

  it("ссылка без партнёра, неизвестный клик, чужой код и неподходящий вид запуска — привязки нет", async () => {
    const code = await link(null);
    const partnerId = await partner();
    const partnerCode = await link(partnerId);
    const me = await account();

    await recorder.record(entry(me, `l-${code}`));
    await recorder.record(entry(me, `c-${await click(code)}`));
    await recorder.record(entry(me, "c-NoSuchClick9"));
    await recorder.record(entry(me, `l-${newLinkCode()}`));
    await recorder.record(entry(me, "invite"));
    await recorder.record(entry(me, null));
    expect(await bindings(me)).toEqual([]);

    // Для сравнения: та же цепочка по ссылке партнёра привязывает.
    await recorder.record(entry(me, `l-${partnerCode}`));
    expect(await bindings(me)).toHaveLength(1);
  });

  it("ссылку удалили — привязка остаётся, а код ссылки в ней пустеет", async () => {
    const partnerId = await partner();
    const code = await link(partnerId);
    const me = await account();
    await recorder.record(entry(me, `l-${code}`));

    await prisma.$executeRaw`DELETE FROM link WHERE code = ${code}`;

    expect(await bindings(me)).toMatchObject([{ partnerId, linkCode: null }]);
  });

  it("партнёра, у которого есть ссылки, удалить нельзя", async () => {
    const partnerId = await partner();
    await link(partnerId);
    await expect(prisma.$executeRaw`DELETE FROM partner WHERE partner_id = ${partnerId}::uuid`).rejects.toThrow();
  });

  it("ссылка партнёра в базе: владелец с названием, фильтр по партнёру, id несуществующего партнёра не принимается", async () => {
    const partnerId = await partner("Канал «Игровой угол»");
    const other = await partner("Блогер");
    const code = await link(partnerId);
    const otherCode = await link(other);
    const own = await link(null);

    expect(await links.byCode(code)).toMatchObject({ code, partner: { partnerId, name: "Канал «Игровой угол»" } });
    expect(await links.byCode(own)).toMatchObject({ partner: null });
    expect(await links.partnerName(partnerId)).toBe("Канал «Игровой угол»");
    expect(await links.partnerName(randomUUID())).toBeNull();

    expect((await links.list(500, { partnerId })).map((row) => row.code)).toEqual([code]);
    const all = (await links.list(500)).map((row) => row.code);
    expect(all).toEqual(expect.arrayContaining([code, otherCode, own]));
  });

  it("карточка партнёра: ссылки с кликами и запусками — теми же числами, что в списке, и привязанные по ссылкам", async () => {
    const partnerId = await partner();
    const code = await link(partnerId, { campaign: "post-1" });
    const quiet = await link(partnerId, { campaign: "post-2" });
    const clicks = [await click(code), await click(code)];
    const direct = await account();
    const clicked = await account();
    const late = await account(10);
    await recorder.record(entry(clicked, `c-${clicks[0] ?? ""}`));
    await recorder.record(entry(direct, `l-${code}`));
    await recorder.record(entry(late, `l-${code}`));
    // Игрока этого партнёра, пришедшего по коду, а не по ссылке, в «по ссылкам» нет.
    const byCode = await account();
    await prisma.$executeRaw`INSERT INTO partner_binding (account_id, partner_id, bound_at) VALUES (${byCode}::uuid, ${partnerId}::uuid, now())`;

    const source = new PrismaPartnerLinksSource(prisma, links);
    const card = await source.forPartner(partnerId);

    expect(card.bound).toBe(2);
    const row = card.links.find((item) => item.code === code);
    const listed = (await links.list(500, { partnerId })).find((item) => item.code === code);
    expect(row).toMatchObject({ code, campaign: "post-1", target: "app", network: null, clicks: 2, launches: 1, directLaunches: 2, bound: 2 });
    expect(row).toMatchObject({ clicks: listed?.clicks, clicks30d: listed?.clicks30d, launches: listed?.launches, directLaunches: listed?.directLaunches });
    expect(card.links.find((item) => item.code === quiet)).toMatchObject({ clicks: 0, launches: 0, directLaunches: 0, bound: 0 });
    expect(card.links).toHaveLength(2);
    expect(await source.forPartner(randomUUID())).toEqual({ links: [], bound: 0 });
  });
});
