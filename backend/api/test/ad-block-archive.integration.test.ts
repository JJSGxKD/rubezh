import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAdsCatalogRepository } from "../src/modules/ads/ads-catalog.repository.js";
import { PrismaAdsRepository } from "../src/modules/ads/ads.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Архив рекламных блоков на живом Postgres (docs/35-stage4-plan.md Р200,
 * tasks/T-0409): отметка и выключение — одной записью, повтор ничего не пишет,
 * правка блока в архиве отбрасывается условием в самой записи, выдача архив
 * не видит. Адрес — TEST_DATABASE_URL, без него пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
const NOON = new Date(Date.UTC(2026, 10, 9, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);

describe.skipIf(DATABASE_URL === "")("архив рекламных блоков на живом Postgres", () => {
  let prisma: PrismaClient;
  let catalog: PrismaAdsCatalogRepository;
  let ads: PrismaAdsRepository;
  const actor = randomUUID();
  /** своя сеть теста: общие из миграции выключены, а чужие тесты её не трогают */
  const network = `it_${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 5);
    catalog = new PrismaAdsCatalogRepository(prisma);
    ads = new PrismaAdsRepository(prisma);
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Архив', true, 5, now())`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** включённый блок своей сети; `ext` отличает блоки друг от друга */
  async function freshBlock(ext: string) {
    const created = await catalog.insertBlock({ networkKey: network, place: "run_double", externalId: ext, success: "view", active: true, platforms: ["telegram"], devices: [] }, actor, NOON);
    if (created === null) throw new Error("блок не заведён");
    return created;
  }

  async function stored(blockId: string) {
    const [found] = await prisma.$queryRaw<{ active: boolean; archived_at: Date | null; updated_at: Date; updated_by: string | null }[]>`
      SELECT active, archived_at, updated_at, updated_by::text FROM ad_block WHERE block_id = ${blockId}::uuid`;
    if (found === undefined) throw new Error("блока нет в базе");
    return found;
  }

  const served = async (blockId: string) => (await ads.activeBlocks()).some((candidate) => candidate.blockId === blockId);

  it("«В архив»: отметка и active = false одной записью, блок виден в каталоге с отметкой; повтор ничего не пишет", async () => {
    const block = await freshBlock("arch-1");
    expect((await catalog.blocks()).find((row) => row.blockId === block.blockId)).toEqual({ ...block, archivedAt: null });

    const archivedBy = randomUUID();
    const first = await catalog.setBlockArchived(block.blockId, true, archivedBy, at(5));
    expect(first).toEqual({ block: { ...block, active: false, archivedAt: at(5).toISOString() }, changed: true });
    expect(await stored(block.blockId)).toMatchObject({ active: false, archived_at: at(5), updated_at: at(5), updated_by: archivedBy });
    expect((await catalog.blocks()).find((row) => row.blockId === block.blockId)).toEqual(first?.block);

    // Второй вызов: состояние то же — ни отметка, ни время правки, ни автор не сдвигаются.
    const second = await catalog.setBlockArchived(block.blockId, true, randomUUID(), at(10));
    expect(second).toEqual({ block: first?.block, changed: false });
    expect(await stored(block.blockId)).toMatchObject({ active: false, archived_at: at(5), updated_at: at(5), updated_by: archivedBy });
  });

  it("«Вернуть»: отметка снята, блок остаётся выключенным; повтор ничего не пишет", async () => {
    const block = await freshBlock("arch-2");
    await catalog.setBlockArchived(block.blockId, true, actor, at(5));

    const restoredBy = randomUUID();
    const restored = await catalog.setBlockArchived(block.blockId, false, restoredBy, at(20));
    expect(restored).toEqual({ block: { ...block, active: false, archivedAt: null }, changed: true });
    expect(await stored(block.blockId)).toMatchObject({ active: false, archived_at: null, updated_at: at(20), updated_by: restoredBy });

    expect(await catalog.setBlockArchived(block.blockId, false, randomUUID(), at(30))).toEqual({ block: restored?.block, changed: false });
    expect(await stored(block.blockId)).toMatchObject({ active: false, archived_at: null, updated_at: at(20), updated_by: restoredBy });
  });

  it("«Вернуть» блока, который не был в архиве, ничего не пишет и не включает и не выключает", async () => {
    const block = await freshBlock("arch-3");
    const result = await catalog.setBlockArchived(block.blockId, false, randomUUID(), at(7));
    expect(result).toEqual({ block: { ...block, archivedAt: null }, changed: false });
    expect(await stored(block.blockId)).toMatchObject({ active: true, archived_at: null, updated_at: NOON, updated_by: actor });
  });

  it("правка блока в архиве отбрасывается: updateBlock отвечает false, в базе active = false", async () => {
    const block = await freshBlock("arch-4");
    await catalog.setBlockArchived(block.blockId, true, actor, at(5));

    expect(await catalog.updateBlock({ ...block, externalId: "changed", active: true }, randomUUID(), at(15))).toBe(false);
    expect(await stored(block.blockId)).toMatchObject({ active: false, archived_at: at(5), updated_at: at(5), updated_by: actor });
    expect((await catalog.blocks()).find((row) => row.blockId === block.blockId)?.externalId).toBe("arch-4");

    // Вернули — правится как прежде.
    await catalog.setBlockArchived(block.blockId, false, actor, at(16));
    expect(await catalog.updateBlock({ ...block, externalId: "changed", active: true }, actor, at(17))).toBe(true);
    expect(await stored(block.blockId)).toMatchObject({ active: true, archived_at: null });
  });

  it("выдача архив не видит: активный блок в выдаче, после архива — нет, после возврата — тоже (блок выключен)", async () => {
    const block = await freshBlock("arch-5");
    expect(await served(block.blockId)).toBe(true);

    await catalog.setBlockArchived(block.blockId, true, actor, at(5));
    expect(await served(block.blockId)).toBe(false);

    await catalog.setBlockArchived(block.blockId, false, actor, at(6));
    expect(await served(block.blockId)).toBe(false);

    await catalog.updateBlock({ ...block, active: true }, actor, at(7));
    expect(await served(block.blockId)).toBe(true);
  });

  it("несуществующий блок — null в обе стороны, ничего не записано", async () => {
    expect(await catalog.setBlockArchived(randomUUID(), true, actor, at(5))).toBeNull();
    expect(await catalog.setBlockArchived(randomUUID(), false, actor, at(5))).toBeNull();
  });

  it("два «В архив» разом — одна запись: один ответ changed: true, второй false", async () => {
    const block = await freshBlock("arch-6");
    const results = await Promise.all([catalog.setBlockArchived(block.blockId, true, actor, at(5)), catalog.setBlockArchived(block.blockId, true, actor, at(6))]);
    expect(results.filter((result) => result?.changed === true)).toHaveLength(1);
    expect(results.every((result) => result?.block.active === false && result.block.archivedAt !== null)).toBe(true);
  });
});
