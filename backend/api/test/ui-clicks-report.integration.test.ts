import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { uiClicksReport, uiScreensReport } from "../src/modules/funnel/ui-clicks-report.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Отчёт «Нажатия» на живом Postgres (tasks/T-0228; адрес — TEST_DATABASE_URL,
 * без него пропуск). Группировка по игрокам и фильтр площадки — это SQL, память
 * их не проверит.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RUN = randomUUID().slice(0, 8);
const SHOP = `t228-shop-${RUN}`;
const HOME = `t228-home-${RUN}`;
const DAY = 86_400_000;
const NOW = new Date("2026-10-20T12:00:00Z");
const FROM = new Date(NOW.getTime() - 30 * DAY);

type Platform = "telegram" | "vk" | "max";

describe.skipIf(DATABASE_URL === "")("отчёт «Нажатия» на живом Postgres", () => {
  let prisma: PrismaClient;

  async function event(eventType: string, install: string, platform: Platform, payload: Record<string, unknown>, at: Date = new Date(NOW.getTime() - DAY)) {
    await prisma.analyticsEvent.create({
      data: {
        eventId: randomUUID(),
        eventType,
        schemaVersion: 1,
        installId: `t228-${RUN}-${install}`,
        sessionId: "s1",
        platform,
        appVersion: "0.0.0-test",
        payload: payload as never,
        occurredAt: at,
        receivedAt: at,
      },
    });
  }
  const view = (install: string, screen: string, platform: Platform = "telegram", at?: Date) => event("screen_viewed", install, platform, { screen, stub: false }, at);
  const click = (install: string, screen: string, control: string, platform: Platform = "telegram", at?: Date) => event("ui_clicked", install, platform, { screen, control }, at);

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 4);
    // Магазин: трое открыли (один дважды), нажали все трое; игрок a — «buy» три раза.
    await view("a", SHOP);
    await view("a", SHOP);
    await view("b", SHOP);
    await view("c", SHOP, "vk");
    await click("a", SHOP, "buy");
    await click("a", SHOP, "buy");
    await click("a", SHOP, "buy");
    await click("b", SHOP, "buy");
    await click("a", SHOP, "tabs.gems");
    await click("c", SHOP, "buy", "vk");
    // Главная: один открыл и нажал.
    await view("a", HOME);
    await click("a", HOME, "play");
    // Вне периода: нажатие за 60 дней до конца в отчёт не попадает.
    await click("a", SHOP, "old", "telegram", new Date(NOW.getTime() - 60 * DAY));
  });

  afterAll(async () => {
    await prisma.analyticsEvent.deleteMany({ where: { installId: { startsWith: `t228-${RUN}-` } } });
    await prisma.$disconnect();
  });

  it("нажатия, игроки и открывшие: повтор одного игрока — одно лицо, несколько нажатий", async () => {
    const report = await uiClicksReport(prisma, { screen: SHOP, from: FROM, to: NOW, platform: null });
    expect(report.opened).toBe(3);
    expect(report.rows).toEqual([
      { control: "buy", clicks: 5, players: 3, share: 100 },
      { control: "tabs.gems", clicks: 1, players: 1, share: 33.3 },
    ]);
  });

  it("площадка отсекает чужие события и открытия", async () => {
    const vk = await uiClicksReport(prisma, { screen: SHOP, from: FROM, to: NOW, platform: "vk" });
    expect(vk.opened).toBe(1);
    expect(vk.rows).toEqual([{ control: "buy", clicks: 1, players: 1, share: 100 }]);
    const telegram = await uiClicksReport(prisma, { screen: SHOP, from: FROM, to: NOW, platform: "telegram" });
    expect(telegram.opened).toBe(2);
    expect(telegram.rows[0]).toEqual({ control: "buy", clicks: 4, players: 2, share: 100 });
  });

  it("экран без событий — пустой отчёт", async () => {
    const report = await uiClicksReport(prisma, { screen: `t228-none-${RUN}`, from: FROM, to: NOW, platform: null });
    expect(report).toEqual({ opened: 0, rows: [] });
  });

  it("список экранов — с числом открывших, по убыванию", async () => {
    const screens = (await uiScreensReport(prisma, FROM, NOW, null)).filter((row) => row.screen === SHOP || row.screen === HOME);
    expect(screens).toEqual([
      { screen: SHOP, players: 3, views: 4 },
      { screen: HOME, players: 1, views: 1 },
    ]);
  });

  it("в ответе нет install_id и других идентификаторов", async () => {
    const report = await uiClicksReport(prisma, { screen: SHOP, from: FROM, to: NOW, platform: null });
    const screens = await uiScreensReport(prisma, FROM, NOW, null);
    const text = JSON.stringify([report, screens]);
    expect(text).not.toContain(`t228-${RUN}`);
    expect(text).not.toMatch(/install|session|event_?id|platformUser/i);
  });
});
