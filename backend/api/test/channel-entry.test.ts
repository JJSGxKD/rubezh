import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { launchVerifiersFor } from "../src/platforms/platforms.module.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { launchFor } from "./helpers/init-data.js";
import { MemoryAccountRepository, MemoryRefreshStore } from "./helpers/memory-auth.js";

// Вход в канал площадки до приложения (docs/35-stage4-plan.md, Р29): /start
// бота заводит аккаунт и становится касанием.

const NOW = Date.parse("2026-09-25T12:00:00Z");
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function service(accounts = new MemoryAccountRepository(), hooks = new AuthHooks()): AuthService {
  return new AuthService(config(), accounts, new MemoryRefreshStore(), hooks, launchVerifiersFor(config()));
}

describe("вход в канал площадки", () => {
  it("заводит аккаунт и сообщает слушателям: место — канал, параметр — из ссылки", async () => {
    const hooks = new AuthHooks();
    const logins: LoginEvent[] = [];
    hooks.onLogin("test", async (login) => void logins.push(login));

    const account = await service(new MemoryAccountRepository(), hooks).enterChannel(
      { platform: "telegram", platformUserId: "555", displayName: "Анна", username: "anna", startParam: "c-promo2026" },
      NOW,
    );
    await Promise.resolve();

    expect(account).toMatchObject({ platform: "telegram", platformUserId: "555", created: true, photoUrl: null });
    expect(logins).toMatchObject([{ place: "channel", created: true, startParam: { kind: "click", ref: "promo2026" }, reason: "launch" }]);
  });

  it("не затирает аватар, полученный при входе в приложение: в обновлении бота его нет", async () => {
    const accounts = new MemoryAccountRepository();
    const auth = service(accounts);
    await auth.loginWithLaunch("telegram", launchFor(555, AUTH_ENV.TELEGRAM_BOT_TOKEN));
    const first = await accounts.byPlatformUser("telegram", "555");
    await accounts.upsert({ ...first!, photoUrl: "https://t.me/i/userpic/555.jpg" }, NOW);

    const after = await auth.enterChannel({ platform: "telegram", platformUserId: "555", displayName: "Анна", username: null, startParam: null }, NOW);
    expect(after.photoUrl).toBe("https://t.me/i/userpic/555.jpg");
    expect(after.created).toBe(false);
  });

  it("заблокированного не отмечает: прогревать его незачем", async () => {
    const accounts = new MemoryAccountRepository();
    const hooks = new AuthHooks();
    const logins: LoginEvent[] = [];
    hooks.onLogin("test", async (login) => void logins.push(login));
    const auth = service(accounts, hooks);
    const entry = { platform: "telegram" as const, platformUserId: "555", displayName: "Анна", username: null, startParam: null };
    const account = await auth.enterChannel(entry, NOW);
    logins.length = 0;
    accounts.ban(account.accountId, "Читы");

    await auth.enterChannel(entry, NOW + 1000);
    expect(logins).toEqual([]);
  });
});

