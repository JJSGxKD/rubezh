import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { imageIdOf } from "../src/modules/media/image-rules.js";
import { PrismaMediaRepository } from "../src/modules/media/media.repository.js";
import { webp } from "./helpers/webp-samples.js";

/**
 * Картинки на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): байты возвращаются как были,
 * одинаковый файл — одна строка, а запись в обход сервиса не положит в базу
 * то, что потом отдастся игрокам.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("картинки на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaMediaRepository;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 30_000 }) });
    repository = new PrismaMediaRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Свой файл на прогон: строки картинок не удаляются, а база общая между прогонами. */
  function unique(): Buffer {
    const base = webp("square96");
    // Хвост после RIFF сделал бы файл негодным для сервиса, но здесь проверяется
    // хранение: базе всё равно, что внутри, лишь бы размер и id сходились.
    return Buffer.concat([base, randomBytes(8)]);
  }

  it("байты возвращаются как были; тот же файл второй раз — та же строка", async () => {
    const bytes = unique();
    const image = { imageId: imageIdOf(bytes), contentType: "image/webp", width: 96, height: 96, sizeBytes: bytes.length, data: bytes, createdBy: "00000000-0000-4000-8000-0000000000aa" };
    const meta = await repository.insert(image);
    expect(meta).toEqual({ imageId: image.imageId, width: 96, height: 96, sizeBytes: bytes.length });
    expect(await repository.insert({ ...image, createdBy: "00000000-0000-4000-8000-0000000000bb" })).toEqual(meta);

    const stored = await repository.byId(image.imageId);
    expect(Buffer.from(stored?.data ?? new Uint8Array()).equals(bytes)).toBe(true);
    expect(stored?.contentType).toBe("image/webp");
    expect(await repository.meta(image.imageId)).toEqual(meta);
    const [row] = await prisma.$queryRaw<{ created_by: string; rows: bigint }[]>`
      SELECT created_by::text, (SELECT count(*) FROM media_image WHERE image_id = ${image.imageId}) AS rows FROM media_image WHERE image_id = ${image.imageId}`;
    expect([row?.created_by, Number(row?.rows)]).toEqual(["00000000-0000-4000-8000-0000000000aa", 1]);
    expect(await repository.byId("0".repeat(64))).toBeNull();
  });

  it("база держит форму: id — хэш, только WebP, размер — честный и до 200 КБ, стороны в пределах", async () => {
    const insert = async (patch: Record<string, unknown>) => {
      const bytes = unique();
      const row = { image_id: imageIdOf(bytes), content_type: "image/webp", width: 96, height: 96, size_bytes: bytes.length, data: bytes, ...patch };
      await prisma.$executeRaw`
        INSERT INTO media_image (image_id, content_type, width, height, size_bytes, data)
        VALUES (${row.image_id}, ${row.content_type}, ${row.width}, ${row.height}, ${row.size_bytes}, ${row.data})`;
    };
    await expect(insert({})).resolves.toBeUndefined();
    await expect(insert({ image_id: "../../etc/passwd" })).rejects.toThrow();
    await expect(insert({ image_id: "A".repeat(64) })).rejects.toThrow();
    await expect(insert({ content_type: "image/svg+xml" })).rejects.toThrow();
    await expect(insert({ size_bytes: 1 })).rejects.toThrow();
    const heavy = randomBytes(204_801);
    await expect(insert({ image_id: imageIdOf(heavy), data: heavy, size_bytes: heavy.length })).rejects.toThrow();
    await expect(insert({ width: 0 })).rejects.toThrow();
    await expect(insert({ height: 4097 })).rejects.toThrow();
  });
});
