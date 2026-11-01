import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import type { TeamSlideGroup, TeamSlideInput } from "../src/modules/home/team-slide-rules.js";
import { PrismaTeamSlideRepository } from "../src/modules/home/team-slide.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

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

  async function create(patch: Partial<TeamSlideInput> = {}, position = 0) {
    const slideId = randomUUID();
    created.push(slideId);
    return await slides.create(slideId, input(patch), position, by, NOW);
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
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
    const updated = await slides.update(slide.slideId, input({ title: slide.title, target: { kind: "link", url: "https://t.me/rubezh" }, platforms: ["max"] }), null, editor, at(HOUR));
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
    expect(await slides.update(running.slideId, input(), null, by, at(2 * HOUR))).toBeNull();
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
          position: 0,
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
    await expect(row({ position: -1 })).rejects.toThrow();
    await expect(row({})).resolves.toBeTruthy();
  });

  describe("порядок слайдов (T-0189)", () => {
    /** Слайды группы в списке `list` — только созданные этим файлом, в порядке базы. */
    async function groupOrder(pinned: boolean, own: readonly string[]): Promise<string[]> {
      const all = await slides.list(500);
      return all.filter((slide) => own.includes(slide.slideId) && slide.pinned === pinned && slide.archivedAt === null).map((slide) => slide.slideId);
    }

    /** Закреплённые слайды файла прячутся, чтобы чужие строки в базе не мешали сравнению групп. */
    async function scratch(count: number, patch: Partial<TeamSlideInput> = {}) {
      const rows = [];
      for (let index = 0; index < count; index++) rows.push(await create({ title: `Порядок ${index}`, ...patch }, 100 + index));
      return rows;
    }

    it("current и list отдают слайды в порядке «закреплённые, место, позже начатый»; снятые в list — в конце", async () => {
      const [a, b, c] = await scratch(3, { pinned: false, endsAt: at(5 * DAY) });
      // Те же места, разные начала: позже начатый — выше.
      const early = await create({ pinned: false, startsAt: at(0), endsAt: at(5 * DAY) }, 200);
      const late = await create({ pinned: false, startsAt: at(HOUR), endsAt: at(5 * DAY) }, 200);
      const own = [a.slideId, b.slideId, c.slideId, early.slideId, late.slideId];
      expect(await groupOrder(false, own)).toEqual([a.slideId, b.slideId, c.slideId, late.slideId, early.slideId]);

      const live = (await slides.current(at(2 * HOUR), at(2 * HOUR + 30_000))).map((slide) => slide.slideId).filter((id) => own.includes(id));
      expect(live).toEqual([a.slideId, b.slideId, c.slideId, late.slideId, early.slideId]);

      const pinnedSlide = await create({ pinned: true, endsAt: at(5 * DAY) }, 9_999);
      const order = (await slides.current(at(2 * HOUR), at(2 * HOUR + 30_000))).map((slide) => slide.slideId).filter((id) => [...own, pinnedSlide.slideId].includes(id));
      expect(order[0]).toBe(pinnedSlide.slideId);

      await slides.archive(a.slideId, by, at(HOUR));
      const listed = (await slides.list(500)).map((slide) => slide.slideId);
      const ownListed = listed.filter((id) => [...own, pinnedSlide.slideId].includes(id));
      expect(ownListed.at(-1)).toBe(a.slideId);
    });

    it("nextPosition: пустая группа — 0, иначе наибольшее место плюс один; снятые не считаются", async () => {
      const pinned = await slides.nextPosition(true);
      const regular = await slides.nextPosition(false);
      expect(pinned).toBeGreaterThanOrEqual(0);
      expect(regular).toBeGreaterThanOrEqual(0);
      const fresh = await create({ pinned: false }, regular + 10);
      expect(await slides.nextPosition(false)).toBe(regular + 11);
      await slides.archive(fresh.slideId, by, at(HOUR));
      expect(await slides.nextPosition(false)).toBe(regular);
    });

    /** Перестановка идёт по всей группе базы, поэтому тест берёт группу целиком из уже существующих строк. */
    async function wholeGroup(pinned: boolean) {
      const rows = (await slides.list(500)).filter((slide) => slide.pinned === pinned && slide.archivedAt === null);
      return rows;
    }

    it("reorder переписывает места 0…n−1 и только у сдвинувшихся строк", async () => {
      const group: TeamSlideGroup = "regular";
      await scratch(3, { pinned: false, endsAt: at(5 * DAY) });
      // Места группы выравниваются запросом в прежнем порядке — дальше сдвигаются только переставленные.
      await slides.reorder(group, (await wholeGroup(false)).map((slide) => slide.slideId), by, at(HOUR));
      const before = await wholeGroup(false);
      expect(before.map((slide) => slide.position)).toEqual(before.map((_, index) => index));
      const ids = before.map((slide) => slide.slideId);
      const swapped = [ids[1] as string, ids[0] as string, ...ids.slice(2)];
      const result = await slides.reorder(group, swapped, by, at(2 * HOUR));
      expect(result).toMatchObject({ status: "ok", changed: true });
      const after = await wholeGroup(false);
      expect(after.map((slide) => slide.slideId)).toEqual(swapped);
      expect(after.map((slide) => slide.position)).toEqual(swapped.map((_, index) => index));
      // Строки, чьё место не поменялось, не тронуты: updated_at прежний.
      for (const slide of after.slice(2)) {
        const was = before.find((candidate) => candidate.slideId === slide.slideId);
        expect(slide.updatedAt).toEqual(was?.updatedAt);
      }
      expect(after[0]?.updatedAt).toEqual(at(2 * HOUR));
      expect(after[0]?.updatedBy).toBe(by);

      const again = await slides.reorder(group, swapped, by, at(3 * HOUR));
      expect(again).toMatchObject({ status: "ok", changed: false });
      expect((await wholeGroup(false)).map((slide) => slide.updatedAt)).toEqual(after.map((slide) => slide.updatedAt));
    });

    it("чужая группа, снятый слайд, несуществующий id и неполный набор — mismatch, места в базе не меняются", async () => {
      await scratch(2, { pinned: false, endsAt: at(5 * DAY) });
      const archived = await create({ pinned: false }, 300);
      await slides.archive(archived.slideId, by, at(HOUR));
      const pinned = await create({ pinned: true }, 301);
      const group = (await wholeGroup(false)).map((slide) => slide.slideId);
      const snapshot = async () => (await slides.list(500)).map((slide) => [slide.slideId, slide.position]);
      const state = await snapshot();
      for (const ids of [[...group, archived.slideId], [...group, pinned.slideId], [...group, randomUUID()], group.slice(1), [...group, group[0] as string]]) {
        expect(await slides.reorder("regular", ids, by, at(2 * HOUR))).toEqual({ status: "mismatch" });
      }
      expect(await snapshot()).toEqual(state);
    });

    it("два одновременных reorder одной группы с разными порядками: оба завершаются, итог — один из двух, места без дублей", async () => {
      await scratch(4, { pinned: false, endsAt: at(5 * DAY) });
      const ids = (await wholeGroup(false)).map((slide) => slide.slideId);
      const forward = [...ids].reverse();
      const rotated = [...ids.slice(1), ids[0] as string];
      const [one, two] = await Promise.all([slides.reorder("regular", forward, by, at(2 * HOUR)), slides.reorder("regular", rotated, by, at(2 * HOUR))]);
      expect(one.status).toBe("ok");
      expect(two.status).toBe("ok");
      const after = await wholeGroup(false);
      const final = after.map((slide) => slide.slideId);
      expect([forward, rotated]).toContainEqual(final);
      expect(after.map((slide) => slide.position)).toEqual(ids.map((_, index) => index));
    });
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
