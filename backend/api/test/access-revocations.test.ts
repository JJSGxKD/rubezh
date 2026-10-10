import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { AccessRevocations } from "../src/modules/auth/access-revocations.js";

/**
 * Отзыв токенов доступа «выйти везде» и блокировкой: метка времени в Redis,
 * токен, выданный раньше неё, не принимается. Redis — подмена на Map.
 */

const config = loadAppConfig({
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "ab".repeat(32),
  TELEGRAM_BOT_TOKEN: "123456:TEST",
  DATABASE_URL: "postgresql://localhost:5432/test",
} as NodeJS.ProcessEnv);

function fakeRedis() {
  const store = new Map<string, string>();
  const sets: unknown[][] = [];
  return {
    store,
    sets,
    set: vi.fn(async (...args: unknown[]) => {
      sets.push(args);
      store.set(String(args[0]), String(args[1]));
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

describe("отзыв токенов доступа", () => {
  it("токен, выданный раньше секунды отзыва, отозван; в ту же секунду и позже — нет", async () => {
    const redis = fakeRedis();
    const revocations = new AccessRevocations(redis as never, config);

    await revocations.revokeBefore("acc", 10_500);

    expect(await revocations.isRevoked("acc", 9)).toBe(true);
    expect(await revocations.isRevoked("acc", 10)).toBe(false);
    expect(await revocations.isRevoked("acc", 11)).toBe(false);
  });

  it("метка ставится с жизнью на 60 секунд дольше токена доступа", async () => {
    const redis = fakeRedis();

    await new AccessRevocations(redis as never, config).revokeBefore("acc", 10_500);

    expect(redis.sets).toEqual([["auth:revoked-before:acc", "10", "EX", config.auth.accessTtlSec + 60]]);
  });

  it("без отзыва ничего не отозвано", async () => {
    const revocations = new AccessRevocations(fakeRedis() as never, config);

    expect(await revocations.isRevoked("acc", 1)).toBe(false);
  });

  it("отзыв одного аккаунта не касается другого", async () => {
    const revocations = new AccessRevocations(fakeRedis() as never, config);

    await revocations.revokeBefore("acc", 10_500);

    expect(await revocations.isRevoked("other", 1)).toBe(false);
  });

  it("недоступный Redis не роняет проверку: токен пропускается, в лог идёт предупреждение", async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error("connection refused"));
    const warn = vi.fn();
    const revocations = new AccessRevocations(redis as never, config, { warn });

    expect(await revocations.isRevoked("acc", 1)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      module: "auth",
      event: "revocation_check_failed",
      reason: "connection refused",
    });
  });
});
