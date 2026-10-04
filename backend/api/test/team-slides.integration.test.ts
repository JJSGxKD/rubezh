import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import type { TeamSlideInput } from "../src/modules/home/team-slide-rules.js";
import { PrismaTeamSlideRepository } from "../src/modules/home/team-slide.repository.js";

/**
 * Слайды команды на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): цель, площадки и срок переживают
 * запись и чтение, снятый уходит из идущих и не правится, а база сама не
 * примет слайд, который ведёт в никуда, кончается до начала или висит без
 * площадки.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 4, 9));

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe.skipIf(DATABASE_URL === "")("слайды команды на живом Postgres", () => {
  let prisma: PrismaClient;
  let slides: PrismaTeamSlideRepository;
  const created: string[] = [];
  const by = randomUUID();

  const input = (patch: Partial<TeamSlideInput> = {}): TeamSlideInput => ({
    title: `Турнир ${randomUUID().slice(0, 8)}`,
    text: "Лучшее время — в рейтинге",
    imageId: null,
    icon: "trophy",
    target: { kind: "screen", screen: "rating" },
    platforms: ["telegram", "vk"],
    audience: "newbies",
    pinned: true,
    startsAt: at(0),
    endsAt: at(3 * DAY),
    ...patch,
  });

  async function create(patch: Partial<TeamSlideInput> = {}) {
    const slideId = randomUUID();
    created.push(slideId);
    return await slides.create(slideId, input(patch), by, NOW);
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    slides = new PrismaTeamSlideRepository(prisma);
  });

  afterAll(async () => {
    await prisma.homeSlide.deleteMany({ where: { slideId: { in: created } } });
    await prisma.$disconnect();
  });

  it("цель, площадки, аудитория и срок переживают запись и чтение; правка меняет и цель", async () => {
    const slide = await create();
    expect(await slides.byId(slide.slideId)).toEqual(slide);
    expect(slide).toMatchObject({ target: { kind: "screen", screen: "rating" }, platforms: ["telegram", "vk"], audience: "newbies", pinned: true, createdBy: by });

    const editor = randomUUID();
    const updated = await slides.update(slide.slideId, input({ title: slide.title, target: { kind: "link", url: "https://t.me/rubezh" }, platforms: ["max"] }), editor, at(HOUR));
    expect(updated).toMatchObject({ target: { kind: "link", url: "https://t.me/rubezh" }, platforms: ["max"], updatedBy: editor, updatedAt: at(HOUR), createdBy: by });
  });

  it("идущие и начинающиеся в окне — в выборке; снятый — нет, не правится и второй раз не снимается", async () => {
    const running = await create();
    const soon = await create({ startsAt: at(10_000), endsAt: at(DAY) });
    const later = await create({ startsAt: at(DAY), endsAt: at(2 * DAY) });
    const ids = async () => (await slides.current(NOW, at(30_000))).map((slide) => slide.slideId);
    expect(await ids()).toEqual(expect.arrayContaining([running.slideId, soon.slideId]));
    expect(await ids()).not.toContain(later.slideId);

    const archived = await slides.archive(running.slideId, by, at(HOUR));
    expect(archived).toMatchObject({ archivedAt: at(HOUR), archivedBy: by });
    expect(await ids()).not.toContain(running.slideId);
    expect(await slides.update(running.slideId, input(), by, at(2 * HOUR))).toBeNull();
    expect(await slides.archive(running.slideId, by, at(2 * HOUR))).toBeNull();
    expect((await slides.list(500)).map((slide) => slide.slideId)).toContain(running.slideId);
  });

  it("база сама не примет цель без экрана, ссылку не https, конец раньше начала, пустые площадки и чужую картинку", async () => {
    const row = (patch: Record<string, unknown>) => {
      const slideId = randomUUID();
      created.push(slideId);
      return prisma.homeSlide.create({
        data: {
          slideId,
          title: "т",
          text: "п",
          icon: "trophy",
          targetKind: "screen",
          targetScreen: "rating",
          platforms: ["telegram"],
          audience: "all",
          pinned: false,
          startsAt: NOW,
          endsAt: at(DAY),
          createdAt: NOW,
          createdBy: by,
          updatedAt: NOW,
          updatedBy: by,
          ...patch,
        },
      });
    };
    await expect(row({ targetScreen: null })).rejects.toThrow();
    await expect(row({ targetKind: "link", targetScreen: null, targetUrl: "http://t.me/x" })).rejects.toThrow();
    await expect(row({ endsAt: NOW })).rejects.toThrow();
    await expect(row({ platforms: [] })).rejects.toThrow();
    await expect(row({ audience: "everyone" })).rejects.toThrow();
    await expect(row({ imageId: "f".repeat(64) })).rejects.toThrow();
    await expect(row({})).resolves.toBeTruthy();
  });

  it("аудитория: регистрация из аккаунта, платил — по первой настоящей оплате; нет аккаунта — null", async () => {
    const payer = randomUUID();
    const fresh = randomUUID();
    const createdAt = at(-2 * DAY);
    for (const accountId of [payer, fresh]) {
      await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: `ts${accountId.slice(0, 12)}`, displayName: "Игрок", createdAt } });
    }
    await prisma.accountFunnel.create({ data: { accountId: payer, firstPurchaseAt: at(-DAY) } });
    try {
      expect(await slides.audienceFacts(payer)).toEqual({ createdAt, payer: true });
      expect(await slides.audienceFacts(fresh)).toEqual({ createdAt, payer: false });
      expect(await slides.audienceFacts(randomUUID())).toBeNull();
    } finally {
      await prisma.account.deleteMany({ where: { accountId: { in: [payer, fresh] } } });
    }
  });
});
