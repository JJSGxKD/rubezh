import "reflect-metadata";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, RateLimitedError, ValidationError } from "../src/common/domain-error.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import type { EventRow } from "../src/modules/events/events.repository.js";
import type { EventsSink } from "../src/modules/events/events.sink.js";
import type { Account } from "../src/modules/auth/account.repository.js";
import { LinkUnavailableError } from "../src/modules/external-identity/external-identity-errors.js";
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  LINK_CODE_PATTERN,
  LINK_CODE_TTL_SEC,
  LINK_START_LIMIT,
  newLinkCode,
} from "../src/modules/external-identity/external-identity-rules.js";
import type { ExternalIdentityRepository, ExternalIdentityRow, LinkResult } from "../src/modules/external-identity/external-identity.repository.js";
import { ExternalIdentityService } from "../src/modules/external-identity/external-identity.service.js";
import type { LinkCodeStore, LinkTarget } from "../src/modules/external-identity/link-codes.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { ExternalLinkStarters, type ExternalLinkStarter } from "../src/platforms/ports/external-link.js";
import type { PlatformId } from "../src/platforms/ports/platform.js";

/**
 * Привязка аккаунта MAX и VK к игровому (docs/35-stage4-plan.md Р188,
 * tasks/T-0377), часть на подменах: код, выдача ссылки и применение кода
 * ботом. Пары «id площадки — аккаунт» на настоящей базе — в
 * `external-identity.integration.test.ts`.
 */

const ME = "00000000-0000-4000-8000-00000000f001";
const OTHER = "00000000-0000-4000-8000-00000000f002";
const PLAYER: AccountRef = { accountId: ME, platform: "telegram", platformUserId: "555000111" };
const NOON = Date.UTC(2026, 10, 10, 9);

// Строки лога модулей в вывод тестов не попадают.
beforeEach(() => {
  for (const level of ["log", "warn"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Redis, которого нет: лимит частоты уходит в память процесса, как при сбое. */
const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

class MemoryCodes implements LinkCodeStore {
  readonly entries = new Map<string, { target: LinkTarget; ttlSec: number }>();
  takes = 0;

  async put(code: string, target: LinkTarget, ttlSec: number): Promise<boolean> {
    if (this.entries.has(code)) return false;
    this.entries.set(code, { target, ttlSec });
    return true;
  }

  async take(code: string): Promise<LinkTarget | null> {
    this.takes++;
    const entry = this.entries.get(code);
    this.entries.delete(code);
    return entry?.target ?? null;
  }
}

/** Те же правила пары, что у настоящего хранилища: одна связь на площадку и один аккаунт на id площадки. */
class MemoryIdentities implements ExternalIdentityRepository {
  readonly rows: ExternalIdentityRow[] = [];

  async find(accountId: string, platform: PlatformId): Promise<ExternalIdentityRow | null> {
    return this.rows.find((row) => row.accountId === accountId && row.platform === platform) ?? null;
  }

  async link(accountId: string, platform: PlatformId, externalUserId: string): Promise<LinkResult> {
    const mine = this.rows.find((row) => row.accountId === accountId && row.platform === platform);
    if (mine !== undefined) return mine.externalUserId === externalUserId ? "already" : "taken";
    if (this.rows.some((row) => row.platform === platform && row.externalUserId === externalUserId)) return "taken";
    this.rows.push({ accountId, platform, externalUserId, linkedAt: new Date(NOON) });
    return "linked";
  }
}

class MemorySink implements EventsSink {
  readonly rows: EventRow[] = [];
  failure: Error | null = null;

  async write(rows: readonly EventRow[]): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.rows.push(...rows);
  }
}

function starter(platform: PlatformId, url: ((code: string) => string | null) | null = (code) => `https://max.ru/rubezh_bot?start=${code}`): ExternalLinkStarter {
  return { platform, startUrl: (code) => (url === null ? null : url(code)) };
}

function account(accountId: string, patch: Partial<Account> = {}): Account {
  return {
    accountId,
    platform: "telegram",
    platformUserId: accountId === ME ? "555000111" : "555000222",
    displayName: "Игрок",
    username: null,
    photoUrl: null,
    createdAt: new Date(NOON),
    bannedAt: null,
    banReason: null,
    created: false,
    ...patch,
  };
}

function setup(starters: readonly ExternalLinkStarter[] = [starter("max")]) {
  const codes = new MemoryCodes();
  const identities = new MemoryIdentities();
  const sink = new MemorySink();
  const accounts = new Map<string, Account>([
    [ME, account(ME)],
    [OTHER, account(OTHER)],
  ]);
  const service = new ExternalIdentityService(
    identities,
    codes,
    new ExternalLinkStarters(starters),
    new RateLimiter(unavailableRedis),
    { byId: async (accountId) => accounts.get(accountId) ?? null },
    sink,
  );
  service.clock = () => NOON;
  return { service, codes, identities, sink, accounts };
}

/** Код из ссылки, которую выдала `startLink`. */
function codeOf(url: string): string {
  return new URL(url).searchParams.get("start") ?? "";
}

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидали доменную ошибку, а вызов прошёл");
}

describe("код привязки", () => {
  it("16 знаков из латиницы и цифр; два кода разные, тысяча кодов не повторяется", () => {
    const first = newLinkCode();
    expect(first).toHaveLength(LINK_CODE_LENGTH);
    expect(LINK_CODE_LENGTH).toBe(16);
    expect(first).toMatch(LINK_CODE_PATTERN);
    expect(newLinkCode()).not.toBe(first);
    const many = new Set(Array.from({ length: 1_000 }, () => newLinkCode()));
    expect(many.size).toBe(1_000);
    for (const code of many) expect(code).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it("алфавит — 62 знака: A–Z, a–z, 0–9", () => {
    expect(LINK_CODE_ALPHABET).toHaveLength(62);
    expect(new Set(LINK_CODE_ALPHABET).size).toBe(62);
    expect(LINK_CODE_ALPHABET).toMatch(/^[A-Za-z0-9]{62}$/);
  });

  it("живёт 30 минут", () => {
    expect(LINK_CODE_TTL_SEC).toBe(1_800);
  });

  it("без смещения: байты 248 и выше отбрасываются, иначе первые знаки алфавита выпадали бы чаще", () => {
    // 62 · 4 = 248: байт от 248 до 255 при делении по модулю дал бы «лишние» A–H.
    const stream = [...Array.from({ length: 40 }, () => 255), ...Array.from({ length: 16 }, (_, index) => index)];
    let position = 0;
    const code = newLinkCode((size) => Uint8Array.from({ length: size }, () => stream[position++] ?? 0));
    expect(code).toBe(LINK_CODE_ALPHABET.slice(0, 16));
  });
});

describe("startLink: выдача ссылки на бота", () => {
  it("своя площадка аккаунта — 400, ссылка не нужна", async () => {
    const ctx = setup([starter("max"), starter("telegram")]);
    const error = await failure(ctx.service.startLink(PLAYER, "telegram"));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(400);
    expect(ctx.codes.entries.size).toBe(0);
  });

  it("площадка, с которой связи не бывает (веб), — 400", async () => {
    const ctx = setup([starter("web")]);
    expect((await failure(ctx.service.startLink(PLAYER, "web"))).status).toBe(400);
  });

  it("стартера нет или площадка не настроена — 503 link_unavailable, код не заводится", async () => {
    const none = setup([]);
    const missing = await failure(none.service.startLink(PLAYER, "max"));
    expect(missing).toBeInstanceOf(LinkUnavailableError);
    expect(missing).toMatchObject({ status: 503, code: "link_unavailable", message: "Бот площадки сейчас недоступен — попробуй позже" });
    expect(none.codes.entries.size).toBe(0);

    const idle = setup([starter("max", null)]);
    expect((await failure(idle.service.startLink(PLAYER, "max"))).code).toBe("link_unavailable");
    expect(idle.codes.entries.size).toBe(0);
  });

  it("недоступная площадка не тратит лимит выдачи", async () => {
    const ctx = setup([starter("max", null)]);
    for (let index = 0; index < 15; index++) expect((await failure(ctx.service.startLink(PLAYER, "max"))).code).toBe("link_unavailable");
  });

  it("выдаёт ссылку с кодом; код хранится на 30 минут и указывает на аккаунт и площадку", async () => {
    const ctx = setup();
    const { url } = await ctx.service.startLink(PLAYER, "max");
    const code = codeOf(url);
    expect(code).toMatch(LINK_CODE_PATTERN);
    expect(url).toBe(`https://max.ru/rubezh_bot?start=${code}`);
    expect(ctx.codes.entries.get(code)).toEqual({ target: { accountId: ME, platform: "max" }, ttlSec: 1_800 });
  });

  it("связь уже есть — ссылка всё равно выдаётся: бот ответит «уже связано» и даст канал", async () => {
    const ctx = setup();
    await ctx.identities.link(ME, "max", "max-user-77");
    const { url } = await ctx.service.startLink(PLAYER, "max");
    expect(codeOf(url)).toMatch(LINK_CODE_PATTERN);
  });

  it("не больше 10 кодов в час на аккаунт: 11-й — 429 rate_limited; у другого аккаунта счёт свой", async () => {
    const ctx = setup();
    expect(LINK_START_LIMIT).toMatchObject({ limit: 10, windowSec: 3_600 });
    for (let index = 0; index < 10; index++) await ctx.service.startLink(PLAYER, "max");
    const eleventh = await failure(ctx.service.startLink(PLAYER, "max"));
    expect(eleventh).toBeInstanceOf(RateLimitedError);
    expect(eleventh).toMatchObject({ status: 429, code: "rate_limited" });
    expect(ctx.codes.entries.size).toBe(10);

    const other: AccountRef = { accountId: OTHER, platform: "telegram", platformUserId: "555000222" };
    await expect(ctx.service.startLink(other, "max")).resolves.toMatchObject({ url: expect.any(String) });
  });
});

describe("consume: бот применяет код", () => {
  it("неизвестный код — expired", async () => {
    const ctx = setup();
    await expect(ctx.service.consume("max", "A".repeat(16), "max-user-77")).resolves.toBe("expired");
    expect(ctx.identities.rows).toEqual([]);
    expect(ctx.sink.rows).toEqual([]);
  });

  it("код не по шаблону — expired, хранилище не спрашивается", async () => {
    const ctx = setup();
    for (const code of ["", "short", "A".repeat(15), "A".repeat(17), `${"A".repeat(15)}-`, `${"A".repeat(15)}\n`, "Я".repeat(16)]) {
      await expect(ctx.service.consume("max", code, "max-user-77")).resolves.toBe("expired");
    }
    expect(ctx.codes.takes).toBe(0);
  });

  it("id игрока не похож на id площадки — 400 от бота, код не сгорает", async () => {
    const ctx = setup();
    const { url } = await ctx.service.startLink(PLAYER, "max");
    for (const id of ["", " ", "a b", "x".repeat(65), "id\n", "<script>"]) {
      expect((await failure(ctx.service.consume("max", codeOf(url), id))).status).toBe(400);
    }
    expect(ctx.codes.entries.size).toBe(1);
    await expect(ctx.service.consume("max", codeOf(url), "max-user-77")).resolves.toBe("linked");
  });

  it("первая связь — linked; id площадки читается через externalId", async () => {
    const ctx = setup();
    const { url } = await ctx.service.startLink(PLAYER, "max");
    await expect(ctx.service.consume("max", codeOf(url), "max-user-77")).resolves.toBe("linked");
    await expect(ctx.service.externalId(ME, "max")).resolves.toBe("max-user-77");
    await expect(ctx.service.externalId(ME, "vk")).resolves.toBeNull();
    await expect(ctx.service.externalId(OTHER, "max")).resolves.toBeNull();
  });

  it("код применяется один раз: второй consume того же кода — expired", async () => {
    const ctx = setup();
    const { url } = await ctx.service.startLink(PLAYER, "max");
    const code = codeOf(url);
    await expect(ctx.service.consume("max", code, "max-user-77")).resolves.toBe("linked");
    await expect(ctx.service.consume("max", code, "max-user-77")).resolves.toBe("expired");
    await expect(ctx.service.consume("max", code, "max-user-88")).resolves.toBe("expired");
    expect(ctx.identities.rows).toHaveLength(1);
  });

  it("код другой площадки — expired, и он сгорает: бот VK не применит код, выданный для MAX", async () => {
    const ctx = setup();
    const { url } = await ctx.service.startLink(PLAYER, "max");
    const code = codeOf(url);
    await expect(ctx.service.consume("vk", code, "vk-user-1")).resolves.toBe("expired");
    await expect(ctx.service.consume("max", code, "max-user-77")).resolves.toBe("expired");
    expect(ctx.identities.rows).toEqual([]);
  });

  it("аккаунта больше нет — expired", async () => {
    const ctx = setup();
    const { url } = await ctx.service.startLink(PLAYER, "max");
    ctx.accounts.delete(ME);
    await expect(ctx.service.consume("max", codeOf(url), "max-user-77")).resolves.toBe("expired");
    expect(ctx.identities.rows).toEqual([]);
  });

  it("тот же id площадки с другим аккаунтом — taken; у второго аккаунта связи нет", async () => {
    const ctx = setup();
    const first = await ctx.service.startLink(PLAYER, "max");
    await ctx.service.consume("max", codeOf(first.url), "max-user-77");
    const second = await ctx.service.startLink({ accountId: OTHER, platform: "telegram", platformUserId: "555000222" }, "max");
    await expect(ctx.service.consume("max", codeOf(second.url), "max-user-77")).resolves.toBe("taken");
    await expect(ctx.service.externalId(OTHER, "max")).resolves.toBeNull();
    await expect(ctx.service.externalId(ME, "max")).resolves.toBe("max-user-77");
  });

  it("у аккаунта уже есть связь на площадке, пришёл другой id — taken, прежняя цела; тот же id — already", async () => {
    const ctx = setup();
    const first = await ctx.service.startLink(PLAYER, "max");
    await ctx.service.consume("max", codeOf(first.url), "max-user-77");
    const again = await ctx.service.startLink(PLAYER, "max");
    await expect(ctx.service.consume("max", codeOf(again.url), "max-user-99")).resolves.toBe("taken");
    const same = await ctx.service.startLink(PLAYER, "max");
    await expect(ctx.service.consume("max", codeOf(same.url), "max-user-77")).resolves.toBe("already");
    await expect(ctx.service.externalId(ME, "max")).resolves.toBe("max-user-77");
  });
});

describe("событие external_account_linked", () => {
  it("на каждый исход, кроме expired: площадка и результат, id площадки в событии нет", async () => {
    const ctx = setup();
    const link = async (account: AccountRef, id: string) => await ctx.service.consume("max", codeOf((await ctx.service.startLink(account, "max")).url), id);
    expect(await link(PLAYER, "max-user-77")).toBe("linked");
    expect(await link(PLAYER, "max-user-77")).toBe("already");
    expect(await link({ accountId: OTHER, platform: "telegram", platformUserId: "555000222" }, "max-user-77")).toBe("taken");
    await ctx.service.consume("max", "B".repeat(16), "max-user-77");

    expect(ctx.sink.rows.map((row) => row.payload)).toEqual([
      { platform: "max", result: "linked" },
      { platform: "max", result: "already" },
      { platform: "max", result: "taken" },
    ]);
    for (const row of ctx.sink.rows) {
      expect(row.eventType).toBe("external_account_linked");
      expect(row.schemaVersion).toBe(EVENT_DICTIONARY.external_account_linked.version);
      expect(EVENT_DICTIONARY.external_account_linked.payload.safeParse(row.payload).success).toBe(true);
      expect(JSON.stringify(row)).not.toContain("max-user-77");
    }
    // игрок в событии — по своей площадке и своему id, как у остальных событий
    expect(ctx.sink.rows[0]).toMatchObject({ platform: "telegram", platformUserId: "555000111" });
    expect(new Set(ctx.sink.rows.map((row) => row.eventId)).size).toBe(3);
  });

  it("запись события не мешает привязке: писатель упал — исход всё равно возвращается", async () => {
    const ctx = setup();
    ctx.sink.failure = new Error("очередь недоступна");
    const { url } = await ctx.service.startLink(PLAYER, "max");
    await expect(ctx.service.consume("max", codeOf(url), "max-user-77")).resolves.toBe("linked");
    await expect(ctx.service.externalId(ME, "max")).resolves.toBe("max-user-77");
  });

  it("словарь: площадка — только max или vk, результат — один из трёх", () => {
    const { payload } = EVENT_DICTIONARY.external_account_linked;
    expect(payload.safeParse({ platform: "max", result: "linked" }).success).toBe(true);
    expect(payload.safeParse({ platform: "vk", result: "taken" }).success).toBe(true);
    expect(payload.safeParse({ platform: "telegram", result: "linked" }).success).toBe(false);
    expect(payload.safeParse({ platform: "max", result: "expired" }).success).toBe(false);
    expect(payload.safeParse({ platform: "max" }).success).toBe(false);
  });
});
