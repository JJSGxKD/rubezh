import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanAll } from "../src/cli/display-names-clean.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Ник при входе на живом Postgres (tasks/T-0150, docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск): вход чистит ник,
 * исходник остаётся для панели, закреплённый ник вход не меняет, команда
 * `names:clean` чистит старые аккаунты пачками.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;
/** Охватывающий знак U+0489 — «кружева», из которых рисуют ник-рисунок. */
const LACE = String.fromCodePoint(0x489);

describe.skipIf(DATABASE_URL === "")("ник при входе на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;

  function newUserId(): string {
    return String(500_000_000 + Math.floor(Math.random() * 400_000_000));
  }

  function login(platformUserId: string, displayName: string, username: string | null = null, nowMs = Date.now()) {
    return accounts.upsert({ platform: "telegram", platformUserId, displayName, username }, nowMs);
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 25);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("новый аккаунт с ником из «кружев»: ник — по username, исходник — как пришёл", async () => {
    const raw = `${LACE} ${LACE}${LACE}`;
    const account = await login(newUserId(), raw, "tolik");

    expect(account.displayName).toBe("tolik");
    const stored = await prisma.account.findUniqueOrThrow({ where: { accountId: account.accountId } });
    expect(stored.displayName).toBe("tolik");
    expect(stored.platformName).toBe(raw);
    expect(stored.nameLockedAt).toBeNull();
  });

  it("ни ника, ни username — «Игрок NNNN», постоянный между входами", async () => {
    const userId = newUserId();
    const first = await login(userId, LACE);
    const again = await login(userId, LACE);

    expect(first.displayName).toMatch(/^Игрок \d{4}$/);
    expect(again.displayName).toBe(first.displayName);
  });

  it("ник с матом при входе не попадает в базу как ник", async () => {
    const account = await login(newUserId(), "хуй", "tolik");

    expect(account.displayName).toBe("tolik");
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId: account.accountId } })).platformName).toBe("хуй");
  });

  it("повторный вход с другим ником: ник новый и чистый, исходник обновлён", async () => {
    const userId = newUserId();
    const first = await login(userId, `Оля ${LACE}`);
    expect(first.displayName).toBe("Оля");

    const second = await login(userId, "Оленька");

    expect(second.accountId).toBe(first.accountId);
    expect(second.displayName).toBe("Оленька");
    const stored = await prisma.account.findUniqueOrThrow({ where: { accountId: first.accountId } });
    expect(stored.displayName).toBe("Оленька");
    expect(stored.platformName).toBe("Оленька");
  });

  it("закреплённый ник вход не меняет, а исходник обновляет", async () => {
    const userId = newUserId();
    const first = await login(userId, "Оленька");
    await prisma.account.update({ where: { accountId: first.accountId }, data: { displayName: "Главная Оля", nameLockedAt: new Date() } });

    const second = await login(userId, "Совсем другой ник");

    expect(second.displayName).toBe("Главная Оля");
    const stored = await prisma.account.findUniqueOrThrow({ where: { accountId: first.accountId } });
    expect(stored.displayName).toBe("Главная Оля");
    expect(stored.platformName).toBe("Совсем другой ник");
    expect(stored.nameLockedAt).not.toBeNull();
  });

  it("снято закрепление — следующий вход снова чистит", async () => {
    const userId = newUserId();
    const first = await login(userId, "Оленька");
    await prisma.account.update({ where: { accountId: first.accountId }, data: { displayName: "Главная Оля", nameLockedAt: new Date() } });
    await login(userId, "Оленька");
    await prisma.account.update({ where: { accountId: first.accountId }, data: { nameLockedAt: null } });

    expect((await login(userId, "Оленька")).displayName).toBe("Оленька");
  });

  it("аккаунт, заведённый до задачи (без исходника), чистится при входе и получает исходник", async () => {
    const userId = newUserId();
    const accountId = randomUUID();
    await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: userId, displayName: `Старый ${LACE}${LACE}` } });

    const account = await login(userId, `Старый ${LACE}${LACE}`);

    expect(account.accountId).toBe(accountId);
    expect(account.displayName).toBe("Старый");
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId } })).platformName).toBe(`Старый ${LACE}${LACE}`);
  });

  it("исходник длиннее 256 знаков обрезается без многоточия и без разрыва пары", async () => {
    // Эмодзи — пара из двух кодовых единиц: обрезка по длине строки разорвала бы её.
    const raw = `Вася ${"😀".repeat(300)}`;
    const account = await login(newUserId(), raw);

    const stored = await prisma.account.findUniqueOrThrow({ where: { accountId: account.accountId } });
    expect([...(stored.platformName ?? "")]).toHaveLength(256);
    expect(stored.platformName?.endsWith("😀")).toBe(true);
    expect(raw.startsWith(stored.platformName ?? "?")).toBe(true);
  });

  it("признак «заведён сейчас»: верен для нового, неверен для старого", async () => {
    const userId = newUserId();
    const nowMs = Date.now();

    const first = await login(userId, "Оленька", null, nowMs);
    const again = await login(userId, "Оленька", null, nowMs + 1_000);

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.accountId).toBe(first.accountId);
  });

  it("аватар и юзернейм обновляются как раньше, неизвестный аватар не затирает сохранённый", async () => {
    const userId = newUserId();
    await accounts.upsert({ platform: "telegram", platformUserId: userId, displayName: "Оленька", username: "olya", photoUrl: "https://example.test/a.png" }, Date.now());

    const second = await login(userId, "Оленька", "olya2");

    expect(second.username).toBe("olya2");
    expect(second.photoUrl).toBe("https://example.test/a.png");
  });

  it(
    "20 параллельных входов одного аккаунта: аккаунт один, ник чистый",
    async () => {
      const userId = newUserId();
      const raw = `Оля ${LACE}${LACE}`;

      const results = await Promise.all(Array.from({ length: 20 }, () => login(userId, raw, "olya")));

      expect(new Set(results.map((result) => result.accountId)).size).toBe(1);
      expect(results.every((result) => result.displayName === "Оля")).toBe(true);
      expect(await prisma.account.count({ where: { platform: "telegram", platformUserId: userId } })).toBe(1);
      const stored = await prisma.account.findUniqueOrThrow({ where: { accountId: results[0]?.accountId ?? "" } });
      expect(stored.displayName).toBe("Оля");
      expect(stored.platformName).toBe(raw);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "параллельные входы не перетирают закрепление, поставленное посреди",
    async () => {
      const userId = newUserId();
      const first = await login(userId, "Оленька");
      await prisma.account.update({ where: { accountId: first.accountId }, data: { displayName: "Главная Оля", nameLockedAt: new Date() } });

      await Promise.all(Array.from({ length: 20 }, (_, index) => login(userId, `Ник ${index}`)));

      expect((await prisma.account.findUniqueOrThrow({ where: { accountId: first.accountId } })).displayName).toBe("Главная Оля");
    },
    RACE_TIMEOUT_MS,
  );
});

describe.skipIf(DATABASE_URL === "")("команда names:clean на живом Postgres", () => {
  let prisma: PrismaClient;
  const created: string[] = [];

  async function legacy(displayName: string, patch: { username?: string | null; platformName?: string | null; nameLockedAt?: Date | null } = {}): Promise<string> {
    const accountId = randomUUID();
    await prisma.account.create({
      data: {
        accountId,
        platform: "telegram",
        platformUserId: String(900_000_000 + Math.floor(Math.random() * 90_000_000)),
        displayName,
        username: patch.username ?? null,
        platformName: patch.platformName ?? null,
        nameLockedAt: patch.nameLockedAt ?? null,
      },
    });
    created.push(accountId);
    return accountId;
  }

  async function stored(accountId: string) {
    return prisma.account.findUniqueOrThrow({ where: { accountId } });
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
  });

  afterAll(async () => {
    // Эти аккаунты ничем не связаны, поэтому стираются без хвостов: тысячу строк на каждый прогон копить незачем.
    await prisma.account.deleteMany({ where: { accountId: { in: created } } });
    await prisma.$disconnect();
  });

  it(
    "--dry-run только считает, без него — чистит; закреплённые и чистые не меняются; повтор ничего не делает",
    async () => {
      const dirty = await legacy(`Оля ${LACE}${LACE}`);
      const swear = await legacy("хуй", { username: "tolik" });
      const clean = await legacy("Оленька");
      const locked = await legacy("хуй", { nameLockedAt: new Date() });

      const dry = await cleanAll(prisma, { dryRun: true });
      expect(dry.planned).toBeGreaterThanOrEqual(2);
      expect(dry.updated).toBe(0);
      expect(dry.byVerdict.profanity).toBeGreaterThanOrEqual(1);
      expect((await stored(dirty)).displayName).toBe(`Оля ${LACE}${LACE}`);
      expect((await stored(dirty)).platformName).toBeNull();

      const real = await cleanAll(prisma, { dryRun: false });
      expect(real.updated).toBeGreaterThanOrEqual(2);

      const dirtyRow = await stored(dirty);
      expect(dirtyRow.displayName).toBe("Оля");
      expect(dirtyRow.platformName).toBe(`Оля ${LACE}${LACE}`);
      const swearRow = await stored(swear);
      expect(swearRow.displayName).toBe("tolik");
      expect(swearRow.platformName).toBe("хуй");
      const cleanRow = await stored(clean);
      expect(cleanRow.displayName).toBe("Оленька");
      expect(cleanRow.platformName).toBeNull();
      const lockedRow = await stored(locked);
      expect(lockedRow.displayName).toBe("хуй");
      expect(lockedRow.platformName).toBeNull();

      const again = await cleanAll(prisma, { dryRun: false });
      expect(again.planned).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "больше одной пачки: курсор не теряет и не повторяет аккаунты",
    async () => {
      const ids: string[] = [];
      for (let index = 0; index < 1_100; index += 1) ids.push(randomUUID());
      const stamp = Date.now();
      await prisma.account.createMany({
        data: ids.map((accountId, index) => ({
          accountId,
          platform: "telegram" as const,
          platformUserId: `${String(stamp)}${String(index).padStart(4, "0")}`,
          displayName: `Игрок ${LACE}${String(index)}`,
        })),
      });
      created.push(...ids);

      const result = await cleanAll(prisma, { dryRun: false });

      expect(result.scanned).toBeGreaterThanOrEqual(1_100);
      const rows = await prisma.account.findMany({ where: { accountId: { in: ids } }, select: { displayName: true, platformName: true } });
      expect(rows).toHaveLength(1_100);
      expect(rows.some((row) => row.displayName.includes(LACE))).toBe(false);
      expect(rows.every((row) => row.platformName?.includes(LACE) === true)).toBe(true);
    },
    120_000,
  );

  it("аккаунт, изменившийся между чтением и записью, пропускается, а не затирается", async () => {
    const accountId = await legacy(`Оля ${LACE}`);
    const result = await cleanAll(prisma, { dryRun: false }, {
      afterRead: async (rows) => {
        // Игрок вошёл посреди чистки: ник и исходник уже новые.
        if (rows.some((row) => row.accountId === accountId)) {
          await prisma.account.update({ where: { accountId }, data: { displayName: "Новый ник", platformName: "Новый ник" } });
        }
      },
    });

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const row = await stored(accountId);
    expect(row.displayName).toBe("Новый ник");
    expect(row.platformName).toBe("Новый ник");
  });
});
