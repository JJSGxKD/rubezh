import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import { secretKey, signAccessToken, verifyAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard, accountOf } from "../src/modules/auth/auth.guard.js";
import { AuthService, hashToken } from "../src/modules/auth/auth.service.js";
import { parseDevUser } from "../src/modules/auth/dev-login.js";
import { MemoryAccountRepository, MemoryRefreshStore } from "./helpers/memory-auth.js";
import { launchFor, signInitData } from "./helpers/init-data.js";

/**
 * Вход и сессии (docs/34-stage3-plan.md, WP1).
 *
 * Проверяется не «вошли — получили токен», а то, ради чего всё это писалось:
 * подделанная подпись не пускает, погашенный токен не работает дважды, а
 * упавший выпуск новой пары не оставляет игрока без входа вовсе.
 */

const BOT_TOKEN = "123456:TEST";
const SECRET = randomBytes(32).toString("hex");

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({
    NODE_ENV: "test",
    AUTH_ENABLED: "true",
    JWT_ACCESS_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DATABASE_URL: "postgresql://localhost:5432/test",
    ...patch,
  } as NodeJS.ProcessEnv);
}

describe("токен доступа", () => {
  const key = secretKey(SECRET);
  const claims = { accountId: crypto.randomUUID(), platform: "telegram" as const, platformUserId: "42" };

  it("подписывает и читает обратно", async () => {
    const token = await signAccessToken(claims, key, 900, 1_000_000);

    expect(await verifyAccessToken(token, key, 1_000_000)).toEqual({ ok: true, claims });
  });

  it("истёкший отличается от неверного: по нему клиент обновляет сессию", async () => {
    const token = await signAccessToken(claims, key, 60, 1_000_000);

    expect(await verifyAccessToken(token, key, 1_000_000 + 61_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("чужой секрет не проходит", async () => {
    const token = await signAccessToken(claims, secretKey(randomBytes(32).toString("hex")), 900, 1_000_000);

    expect(await verifyAccessToken(token, key, 1_000_000)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("правленая полезная нагрузка не проходит", async () => {
    const token = await signAccessToken(claims, key, 900, 1_000_000);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: crypto.randomUUID(), platform: "telegram", platformUserId: "1" })).toString("base64url");

    expect(await verifyAccessToken(`${header}.${forged}.${signature}`, key, 1_000_000)).toMatchObject({ ok: false });
  });

  it("токен без подписи не проходит: alg none — классическая дыра JWT", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: crypto.randomUUID(), platform: "telegram", platformUserId: "1", iss: "rubezh" })).toString("base64url");

    expect(await verifyAccessToken(`${header}.${payload}.`, key, 1_000_000)).toMatchObject({ ok: false });
  });
});

describe("вход и продление сессии", () => {
  let accounts: MemoryAccountRepository;
  let refresh: MemoryRefreshStore;
  let service: AuthService;

  beforeEach(() => {
    accounts = new MemoryAccountRepository();
    refresh = new MemoryRefreshStore();
    service = new AuthService(config(), accounts, refresh);
  });

  it("заводит аккаунт по подписанным данным запуска", async () => {
    const result = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));

    expect(result.account.platformUserId).toBe("555");
    expect(result.account.created).toBe(true);
    expect(result.expiresInSec).toBe(900);
  });

  it("второй вход — тот же аккаунт, а не новый", async () => {
    const first = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));
    const second = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));

    expect(second.account.accountId).toBe(first.account.accountId);
    expect(second.account.created).toBe(false);
  });

  it("подделанную подпись не пускает", async () => {
    await expect(service.loginWithTelegram(launchFor(555, "999:ЧУЖОЙ"))).rejects.toThrow(DomainError);
  });

  it("данные запуска старше окна не пускает", async () => {
    const stale = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000) - 7200), user: JSON.stringify({ id: 7, first_name: "Пётр" }) },
      BOT_TOKEN,
    );

    await expect(service.loginWithTelegram(stale)).rejects.toThrow(/устарели/);
  });

  it("заблокированный аккаунт не входит", async () => {
    const { account } = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));
    accounts.ban(account.accountId, "Читы в забегах");

    await expect(service.loginWithTelegram(launchFor(555, BOT_TOKEN))).rejects.toThrow(/Читы/);
  });

  it("продление выдаёт новую пару и гасит старую", async () => {
    const login = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));

    const renewed = await service.refreshSession(login.refreshToken);

    expect(renewed.refreshToken).not.toBe(login.refreshToken);
    expect(renewed.account.accountId).toBe(login.account.accountId);
    await expect(service.refreshSession(login.refreshToken)).rejects.toThrow(DomainError);
  });

  it("повторное использование погашенного сбрасывает все сессии аккаунта", async () => {
    const login = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));
    const renewed = await service.refreshSession(login.refreshToken);

    // Украденный токен: им уже воспользовались, и второй раз он приходит от
    // того, у кого его быть не должно. Отличить вора от повтора нельзя.
    await expect(service.refreshSession(login.refreshToken)).rejects.toThrow(/Сессия сброшена/);
    await expect(service.refreshSession(renewed.refreshToken)).rejects.toThrow(DomainError);
  });

  it("упавший выпуск новой пары возвращает старый токен: иначе игрок заперт", async () => {
    const login = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));
    refresh.failIssue = true;

    await expect(service.refreshSession(login.refreshToken)).rejects.toThrow("хранилище недоступно");

    refresh.failIssue = false;
    const renewed = await service.refreshSession(login.refreshToken);
    expect(renewed.refreshToken).not.toBe(login.refreshToken);
  });

  it("выход гасит токен этого устройства", async () => {
    const login = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));

    await service.logout(login.refreshToken);

    await expect(service.refreshSession(login.refreshToken)).rejects.toThrow(/сброшена|не найдена/);
  });

  it("выход со всех устройств гасит все сессии аккаунта", async () => {
    const first = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));
    await service.loginWithTelegram(launchFor(555, BOT_TOKEN));

    expect(await service.logoutEverywhere(first.account.accountId)).toBe(2);
    expect(refresh.liveCount).toBe(0);
  });

  it("в хранилище уходит хэш, а не сам токен: слепок базы не даёт входа", async () => {
    const login = await service.loginWithTelegram(launchFor(555, BOT_TOKEN));

    expect(hashToken(login.refreshToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(login.refreshToken)).not.toBe(login.refreshToken);
  });
});

describe("конфигурация авторизации", () => {
  it("включённая авторизация без секрета не стартует", () => {
    expect(() => config({ JWT_ACCESS_SECRET: "" })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("включённая авторизация без токена бота не стартует", () => {
    expect(() => config({ TELEGRAM_BOT_TOKEN: "" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("короткий секрет не принимается", () => {
    expect(() => config({ JWT_ACCESS_SECRET: "abc123" })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("окно данных запуска для входа нельзя поднять выше часа", () => {
    // Потолок в схеме, а не в договорённости: на этой сессии работают деньги
    // (docs/33-telegram-mini-app-pitfalls.md §1.2).
    expect(() => config({ AUTH_INIT_DATA_MAX_AGE_SEC: "86400" })).toThrow();
    expect(config({ AUTH_INIT_DATA_MAX_AGE_SEC: "3600" }).auth.initDataMaxAgeSec).toBe(3600);
  });
});

describe("вход разработчика без Telegram", () => {
  // Вход без подписи: цена ошибки — чужой аккаунт или такой вход в проде.
  // Поэтому проверяется не только «пускает», но и где не пускает.
  const DEV = { NODE_ENV: "development", AUTH_DEV_LOGIN: "true" };

  it("имя разбирается, пустое заменяется, длинное обрезается", () => {
    expect(parseDevUser("dev-1:Иван Петров")).toEqual({ platformUserId: "dev-1", displayName: "Иван Петров" });
    expect(parseDevUser("dev-1")).toEqual({ platformUserId: "dev-1", displayName: "Разработчик" });
    expect(parseDevUser("dev-1:  ")?.displayName).toBe("Разработчик");
    expect(parseDevUser("dev-1:a:b")?.displayName).toBe("a:b");
    expect(parseDevUser(`dev-1:${"я".repeat(100)}`)?.displayName).toHaveLength(64);
  });

  it("не принимает то, что может совпасть с игроком или сломать ключ", () => {
    // Числовой ID — это настоящий игрок Telegram: войти за него без подписи
    // нельзя даже на машине разработчика.
    for (const value of ["555", "dev-", "dev-UPPER", "dev-a b", "игрок:dev-1", `dev-${"a".repeat(33)}`]) {
      expect(parseDevUser(value), value).toBeNull();
    }
  });

  it("заводит аккаунт и выдаёт обычную сессию", async () => {
    const service = new AuthService(config(DEV), new MemoryAccountRepository(), new MemoryRefreshStore());

    const result = await service.loginAsDeveloper("dev-1:Проверка");

    expect(result.account).toMatchObject({ platform: "telegram", platformUserId: "dev-1", displayName: "Проверка", created: true });
    expect(result.refreshToken).not.toBe("");
  });

  it("выключенный вход не пускает, даже если контроллер пропустил", async () => {
    const service = new AuthService(config({ NODE_ENV: "development" }), new MemoryAccountRepository(), new MemoryRefreshStore());

    await expect(service.loginAsDeveloper("dev-1:Проверка")).rejects.toMatchObject({ code: "endpoint_disabled" });
  });

  it("битое имя — ошибка разбора, а не аккаунт", async () => {
    const service = new AuthService(config(DEV), new MemoryAccountRepository(), new MemoryRefreshStore());

    await expect(service.loginAsDeveloper("555:Чужой")).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("вне development и без авторизации процесс не поднимается", () => {
    expect(() => config({ NODE_ENV: "production", AUTH_DEV_LOGIN: "true" })).toThrow(/development/);
    expect(() => config({ ...DEV, AUTH_ENABLED: "false" })).toThrow(/AUTH_ENABLED/);
  });
});

describe("доступ по токену", () => {
  const key = secretKey(SECRET);
  const claims = { accountId: crypto.randomUUID(), platform: "telegram" as const, platformUserId: "42" };

  /** Минимальный контекст Nest: guard читает из запроса только заголовки. */
  const contextWith = (authorization?: string) => {
    const request: Record<string, unknown> = { headers: authorization === undefined ? {} : { authorization } };
    return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as never };
  };

  it("пускает с исправным токеном и кладёт аккаунт в запрос", async () => {
    const token = await signAccessToken(claims, key, 900, Date.now());
    const { request, context } = contextWith(`Bearer ${token}`);

    expect(await new AuthGuard(config()).canActivate(context)).toBe(true);
    expect(accountOf(request)).toEqual(claims);
  });

  it("без заголовка не пускает", async () => {
    await expect(new AuthGuard(config()).canActivate(contextWith().context)).rejects.toThrow(/токен доступа/i);
  });

  it("истёкший токен — отдельный код: по нему клиент обновляет сессию", async () => {
    const token = await signAccessToken(claims, key, 60, Date.now() - 120_000);

    await expect(new AuthGuard(config()).canActivate(contextWith(`Bearer ${token}`).context)).rejects.toMatchObject({
      code: "token_expired",
      status: 401,
    });
  });

  it("выключенная авторизация отвечает 404, а не 403: эндпоинт себя не выдаёт", async () => {
    const token = await signAccessToken(claims, key, 900, Date.now());

    await expect(
      new AuthGuard(config({ AUTH_ENABLED: "false" })).canActivate(contextWith(`Bearer ${token}`).context),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("схема не Bearer не пускает: подпись запуска сюда не годится", async () => {
    await expect(new AuthGuard(config()).canActivate(contextWith("tma user=...").context)).rejects.toThrow(DomainError);
  });
});
