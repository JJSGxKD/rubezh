import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { AuthHooks } from "../src/modules/auth/auth-hooks.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { launchVerifiersFor } from "../src/platforms/platforms.module.js";
import { LaunchVerifiers } from "../src/platforms/ports/launch-verifier.js";
import { TelegramLaunchVerifier } from "../src/platforms/telegram/telegram-launch-verifier.js";
import { UnsupportedLaunchVerifier } from "../src/platforms/unsupported.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { launchFor } from "./helpers/init-data.js";
import { MemoryAccountRepository, MemoryRefreshStore } from "./helpers/memory-auth.js";

// Порт проверки запуска (docs/35-stage4-plan.md, §3.11): домен спрашивает
// «кто это», а как площадка подписывает — знает только её адаптер.

const BOT_TOKEN = AUTH_ENV.TELEGRAM_BOT_TOKEN;
const NOW = Date.parse("2026-09-25T12:00:00Z");
const HOUR = 3_600;

describe("проверка запуска Telegram", () => {
  const verifier = new TelegramLaunchVerifier(BOT_TOKEN);

  it("отдаёт игрока, время подписи и параметр запуска", () => {
    const check = verifier.verify(launchFor(555, BOT_TOKEN, NOW), HOUR, NOW);
    expect(check).toMatchObject({ ok: true, player: { id: "555", name: "Анна" }, startParam: null });
    expect(check.ok && check.signedAtSec).toBe(Math.floor(NOW / 1000) - 60);
  });

  it("сводит причины отказа к тем, что нужны домену", () => {
    expect(verifier.verify(launchFor(555, BOT_TOKEN, NOW - 2 * HOUR * 1000), HOUR, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(verifier.verify(launchFor(555, "999:ЧУЖОЙ", NOW), HOUR, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(verifier.verify("мусор", HOUR, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("без токена бота не проверяет вовсе, а говорит «не настроено»", () => {
    const empty = new TelegramLaunchVerifier("");
    expect(empty.configured).toBe(false);
    expect(empty.verify(launchFor(555, BOT_TOKEN, NOW), HOUR, NOW)).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("выбор проверки", () => {
  const verifiers = new LaunchVerifiers([new TelegramLaunchVerifier(BOT_TOKEN), new UnsupportedLaunchVerifier("max")]);

  it("по площадке и по схеме заголовка", () => {
    expect(verifiers.for("telegram")?.authScheme).toBe("tma");
    expect(verifiers.byScheme("tma")?.platform).toBe("telegram");
    expect(verifiers.for("vk")).toBeNull();
    expect(verifiers.byScheme("Bearer")).toBeNull();
  });

  it("площадка без адаптера честно отвечает «не умею»", () => {
    expect(verifiers.for("max")?.verify("что угодно", HOUR, NOW)).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("вход через порт", () => {
  const config = (): AppConfig => loadAppConfig({ ...AUTH_ENV, AUTH_ENABLED: "true" });
  const service = (): AuthService =>
    new AuthService(config(), new MemoryAccountRepository(), new MemoryRefreshStore(), new AuthHooks(), launchVerifiersFor(config()));

  it("заводит аккаунт той площадки, чью подпись проверил", async () => {
    const { account } = await service().loginWithLaunch("telegram", launchFor(555, BOT_TOKEN));
    expect(account).toMatchObject({ platform: "telegram", platformUserId: "555" });
  });

  it("площадка без адаптера не входит, а не падает", async () => {
    await expect(service().loginWithLaunch("max", launchFor(555, BOT_TOKEN))).rejects.toThrow(/не прошли проверку/);
  });
});
