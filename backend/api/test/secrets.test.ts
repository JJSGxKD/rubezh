import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { AdminSecretsService } from "../src/modules/admin/admin-secrets.service.js";
import { fxSources } from "../src/modules/fx/fx.refresher.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { SECRETS, SECRET_KEY, SECRET_LIST, fingerprintOf, secretProblem, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import { safePath } from "../src/infra/outbound/outbound-path.js";
import { SecretCipher, SecretUnreadableError, keyIdOf, type SealedSecret } from "../src/modules/secrets/secret-cipher.js";
import type { SecretsRepository, StoredSecret } from "../src/modules/secrets/secrets.repository.js";
import { SECRETS_CHANNEL, SecretsDisabledError, SecretsService } from "../src/modules/secrets/secrets.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Ключи интеграций (docs/35-stage4-plan.md Р84, WP46): значение лежит в базе
 * только шифртекстом, строку не переложить под другой ключ, панель → окружение,
 * значение не уходит ни в ответ панели, ни в аудит, ни в Redis.
 */

const KEY = randomBytes(32).toString("base64");
const OLD_KEY = randomBytes(32).toString("base64");
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const PRO = "CG-ProSecretValue12345";
const DEMO = "CG-DemoSecretValue6789";

class MemorySecrets implements SecretsRepository {
  readonly rows = new Map<string, StoredSecret>();
  fail = false;

  async all(): Promise<StoredSecret[]> {
    if (this.fail) throw new Error("connection refused");
    return [...this.rows.values()];
  }

  async save(key: string, sealed: SealedSecret, updatedBy: string): Promise<StoredSecret> {
    const row = { key, ...sealed, updatedBy, updatedAt: new Date() };
    this.rows.set(key, row);
    return row;
  }

  async remove(key: string): Promise<StoredSecret | null> {
    const row = this.rows.get(key) ?? null;
    this.rows.delete(key);
    return row;
  }
}

/** Redis ровно настолько, насколько его трогает хранилище: сообщение и подписка. */
class FakeRedis {
  readonly published: string[] = [];

  async publish(channel: string, message: string): Promise<number> {
    this.published.push(`${channel}:${message}`);
    return 1;
  }

  duplicate(): FakeRedis {
    return this;
  }

  on(): this {
    return this;
  }

  async subscribe(): Promise<number> {
    return 1;
  }

  disconnect(): void {
    return undefined;
  }
}

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, SECRETS_ENCRYPTION_KEY: KEY, ...env } as NodeJS.ProcessEnv);
}

function setup(env: Record<string, string> = {}, repository = new MemorySecrets()) {
  const redis = new FakeRedis();
  const service = new SecretsService(config(env), repository, redis as unknown as Redis);
  return { repository, redis, service };
}

describe("шифрование", () => {
  it("туда и обратно; IV своё у каждой записи; отпечаток ключа — не сам ключ", () => {
    const cipher = new SecretCipher([KEY]);
    const first = cipher.seal("fx.coingecko-pro", PRO);
    const second = cipher.seal("fx.coingecko-pro", PRO);
    expect(cipher.open("fx.coingecko-pro", first)).toBe(PRO);
    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
    expect(Buffer.from(first.ciphertext).toString("utf8")).not.toContain("ProSecret");
    expect(first.keyId).toBe(keyIdOf(Buffer.from(KEY, "base64")));
    expect(KEY).not.toContain(first.keyId);
  });

  it("строку не переложить под другой ключ и не поправить в обход панели", () => {
    const cipher = new SecretCipher([KEY]);
    const sealed = cipher.seal("fx.coingecko-pro", PRO);
    expect(() => cipher.open("fx.coingecko-demo", sealed)).toThrow(SecretUnreadableError);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => cipher.open("fx.coingecko-pro", { ...sealed, ciphertext: tampered })).toThrow(SecretUnreadableError);
  });

  it("прежний ключ читает старые строки, новые пишутся текущим; без прежнего — не читается", () => {
    const old = new SecretCipher([OLD_KEY]).seal("fx.coingecko-pro", PRO);
    const rotated = new SecretCipher([KEY, OLD_KEY]);
    expect(rotated.open("fx.coingecko-pro", old)).toBe(PRO);
    expect(rotated.seal("fx.coingecko-pro", PRO).keyId).toBe(rotated.currentKeyId);
    expect(() => new SecretCipher([KEY]).open("fx.coingecko-pro", old)).toThrow("ключом, которого нет");
  });
});

describe("окружение", () => {
  it("ключ шифрования — 32 байта в base64, иначе процесс не поднимается", () => {
    expect(() => config({ SECRETS_ENCRYPTION_KEY: "short" })).toThrow("openssl rand -base64 32");
    expect(() => config({ SECRETS_ENCRYPTION_KEY: randomBytes(16).toString("base64") })).toThrow("SECRETS_ENCRYPTION_KEY");
    expect(config().secrets.encryptionKeys).toEqual([KEY]);
    expect(config({ SECRETS_ENCRYPTION_KEY: "" }).secrets.encryptionKeys).toEqual([]);
  });

  it("прежний ключ без текущего — недописанная смена, старт падает", () => {
    expect(() => config({ SECRETS_ENCRYPTION_KEY: "", SECRETS_ENCRYPTION_KEY_PREVIOUS: OLD_KEY })).toThrow("SECRETS_ENCRYPTION_KEY_PREVIOUS");
    expect(config({ SECRETS_ENCRYPTION_KEY_PREVIOUS: OLD_KEY }).secrets.encryptionKeys).toEqual([KEY, OLD_KEY]);
  });
});

describe("каталог ключей", () => {
  it("имена уникальны и в формате, у каждого — сервис, подсказка и пример своего вида", () => {
    const keys = SECRET_LIST.map((secret) => secret.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const secret of SECRET_LIST) {
      expect(secret.key, secret.key).toMatch(SECRET_KEY);
      expect(secret.hint.length, secret.key).toBeGreaterThan(10);
      expect(secretProblem(secret, secret.example), secret.key).toBeNull();
    }
  });

  it("опечатки ловятся до записи: пробел, перенос строки, чужой вид", () => {
    expect(secretProblem(SECRETS.coingeckoPro, `${PRO}\n`)).toContain("без пробелов");
    expect(secretProblem(SECRETS.coingeckoPro, "CG- 123")).toContain("без пробелов");
    expect(secretProblem(SECRETS.coingeckoPro, "abc123456789")).toContain("CG-");
    expect(fingerprintOf(PRO)).toBe("••••2345");
    expect(fingerprintOf("short")).toBe("••••");
  });
});

describe("порядок значений", () => {
  it("панель → окружение → не задан", async () => {
    const { service } = setup({ FX_COINGECKO_PRO_KEY: "CG-FromEnvironment1" });
    expect(service.get(SECRETS.coingeckoPro)).toBe("CG-FromEnvironment1");
    expect(service.get(SECRETS.coingeckoDemo)).toBeNull();

    await service.write(SECRETS.coingeckoPro, PRO, ACTOR_ID);
    expect(service.get(SECRETS.coingeckoPro)).toBe(PRO);
    expect(service.describe().find((state) => state.secret.key === "fx.coingecko-pro")).toMatchObject({ source: "base", fingerprint: "••••2345", envSet: true, updatedBy: ACTOR_ID });

    expect(await service.clear(SECRETS.coingeckoPro)).toBe(true);
    expect(service.get(SECRETS.coingeckoPro)).toBe("CG-FromEnvironment1");
    expect(await service.clear(SECRETS.coingeckoPro)).toBe(false);
  });

  it("в базе — шифртекст, в Redis — только имя ключа", async () => {
    const { repository, redis, service } = setup();
    await service.write(SECRETS.coingeckoDemo, DEMO, ACTOR_ID);
    const row = repository.rows.get("fx.coingecko-demo");
    expect(Buffer.from(row?.ciphertext ?? new Uint8Array()).toString("utf8")).not.toContain("DemoSecret");
    expect(redis.published).toEqual([`${SECRETS_CHANNEL}:fx.coingecko-demo`]);
  });

  it("соседняя реплика видит запись при перечитывании", async () => {
    const shared = new MemorySecrets();
    const writer = setup({}, shared).service;
    const reader = setup({}, shared).service;
    await writer.write(SECRETS.coingeckoDemo, DEMO, ACTOR_ID);
    expect(reader.get(SECRETS.coingeckoDemo)).toBeNull();
    await reader.refresh();
    expect(reader.get(SECRETS.coingeckoDemo)).toBe(DEMO);
  });

  it("строку не прочитать (сменили ключ шифрования) — работает окружение, панель видит причину", async () => {
    const repository = new MemorySecrets();
    await setup({ SECRETS_ENCRYPTION_KEY: OLD_KEY }, repository).service.write(SECRETS.coingeckoPro, PRO, ACTOR_ID);
    const { service } = setup({ FX_COINGECKO_PRO_KEY: "CG-FromEnvironment1" }, repository);
    await service.refresh();
    expect(service.get(SECRETS.coingeckoPro)).toBe("CG-FromEnvironment1");
    expect(service.describe().find((state) => state.secret.key === "fx.coingecko-pro")).toMatchObject({ source: "env", unreadable: true, updatedBy: ACTOR_ID });
  });

  it("база недоступна — остаются последние прочитанные ключи", async () => {
    const { repository, service } = setup();
    await service.write(SECRETS.coingeckoDemo, DEMO, ACTOR_ID);
    repository.fail = true;
    await service.refresh();
    expect(service.get(SECRETS.coingeckoDemo)).toBe(DEMO);
  });

  it("без ключа шифрования хранилище выключено: окружение читается, записи нет", async () => {
    const { service } = setup({ SECRETS_ENCRYPTION_KEY: "", FX_COINGECKO_DEMO_KEY: DEMO });
    expect(service.enabled).toBe(false);
    expect(service.get(SECRETS.coingeckoDemo)).toBe(DEMO);
    await expect(service.write(SECRETS.coingeckoDemo, DEMO, ACTOR_ID)).rejects.toBeInstanceOf(SecretsDisabledError);
  });

  it("курсы берут ключ CoinGecko на каждом проходе: заменённый в панели работает без перезапуска", async () => {
    const { service } = setup({ FX_COINGECKO_DEMO_KEY: DEMO });
    const tariff = () => fxSources(service).find((source) => source.id === "coingecko")?.tariff.name;
    expect(tariff()).toBe("demo");
    await service.write(SECRETS.coingeckoPro, PRO, ACTOR_ID);
    expect(tariff()).toBe("pro");
  });
});

describe("ключи в панели", () => {
  const OWNER_ID = "777000111";

  async function panel(env: Record<string, string> = {}) {
    const cfg = config({ ADMIN_TELEGRAM_IDS: OWNER_ID, ...env });
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const roles = new RolesService(cfg, rolesRepository, accounts);
    const secrets = new SecretsService(cfg, new MemorySecrets(), new FakeRedis() as unknown as Redis);
    const admin = new AdminSecretsService(secrets, roles, accounts, cfg);
    const ownerAccount = await accounts.upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null, photoUrl: null }, Date.now());
    const adminAccount = await accounts.upsert({ platform: "telegram", platformUserId: "6", displayName: "Админ", username: null, photoUrl: null }, Date.now());
    const strangerAccount = await accounts.upsert({ platform: "telegram", platformUserId: "5", displayName: "Гость", username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(adminAccount.accountId, "admin", null);
    const ref = (account: typeof ownerAccount) => ({ accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId });
    return { admin, secrets, rolesRepository, owner: ref(ownerAccount), administrator: ref(adminAccount), stranger: ref(strangerAccount) };
  }

  it("запись — с проверкой вида и в аудит последними знаками, а не значением", async () => {
    const { admin, rolesRepository, owner } = await panel({ FX_COINGECKO_PRO_KEY: "CG-FromEnvironment1" });
    const saved = await admin.save(owner, "fx.coingecko-pro", `  ${PRO}  `);
    expect(saved).toMatchObject({ source: "base", fingerprint: "••••2345", envSet: true, updatedByName: "Владелец", checkable: true });
    const [entry] = await rolesRepository.recentAudit(10);
    expect(entry).toMatchObject({ action: "secrets.save", target: "fx.coingecko-pro", before: { title: "Платный ключ CoinGecko", source: "env", fingerprint: "••••ent1" }, after: { source: "base", fingerprint: "••••2345" } });
    expect(JSON.stringify(entry)).not.toContain("ProSecret");
    expect(JSON.stringify(await admin.list(owner))).not.toContain("ProSecret");
  });

  it("опечатка — 400 с объяснением, чужое имя — 404", async () => {
    const { admin, owner } = await panel();
    await expect(admin.save(owner, "fx.coingecko-pro", "abc 123")).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("без пробелов") });
    await expect(admin.save(owner, "fx.coingecko-pro", "abcdefghijkl")).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("CG-") });
    await expect(admin.save(owner, "telegram.bot-token", PRO)).rejects.toMatchObject({ code: "secret_not_found", status: 404 });
  });

  it("администратор видит состояние, менять может только владелец; посторонний — ничего", async () => {
    const { admin, administrator, stranger } = await panel();
    await expect(admin.list(administrator)).resolves.toMatchObject({ enabled: true });
    await expect(admin.save(administrator, "fx.coingecko-pro", PRO)).rejects.toMatchObject({ code: "forbidden" });
    await expect(admin.reset(administrator, "fx.coingecko-pro")).rejects.toMatchObject({ code: "forbidden" });
    await expect(admin.list(stranger)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("проверка: действующим ключом — правом смотреть, ключом из формы — правом менять", async () => {
    const { admin, owner, administrator } = await panel({ FX_COINGECKO_DEMO_KEY: DEMO });
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("{}", { status: url.startsWith("https://pro-api") ? 401 : 200 });
    }) as typeof fetch;

    await expect(admin.check(administrator, "fx.coingecko-demo", null, fakeFetch)).resolves.toEqual({ ok: true, message: "CoinGecko принял ключ" });
    expect(asked[0]).toEqual({ url: "https://api.coingecko.com/api/v3/ping", headers: { "x-cg-demo-api-key": DEMO, accept: "application/json" } });
    await expect(admin.check(administrator, "fx.coingecko-pro", PRO, fakeFetch)).rejects.toMatchObject({ code: "forbidden" });
    await expect(admin.check(owner, "fx.coingecko-pro", PRO, fakeFetch)).resolves.toMatchObject({ ok: false, message: expect.stringContaining("не принял") });
    await expect(admin.check(owner, "fx.coingecko-pro", null, fakeFetch)).rejects.toMatchObject({ code: "secret_missing" });
  });

  it("сервис не ответил — ключ не проверен, а не «неверный»", async () => {
    const { admin, owner } = await panel();
    const timeout = (async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }) as typeof fetch;
    await expect(admin.check(owner, "fx.coingecko-demo", DEMO, timeout)).resolves.toEqual({ ok: false, message: "CoinGecko не ответил за 5 секунд — ключ не проверен" });
  });

  it("хранилище выключено — панель так и говорит, запись отклоняется с подсказкой", async () => {
    const { admin, owner } = await panel({ SECRETS_ENCRYPTION_KEY: "" });
    await expect(admin.list(owner)).resolves.toMatchObject({ enabled: false });
    await expect(admin.save(owner, "fx.coingecko-demo", DEMO)).rejects.toMatchObject({ code: "secrets_disabled", message: expect.stringContaining("SECRETS_ENCRYPTION_KEY") });
  });

  it("адрес награды создаёт сервер: показывает его один раз, в списке и аудите — только знаки", async () => {
    const { admin, secrets, rolesRepository, owner, administrator } = await panel({ PUBLIC_API_URL: "https://api.example.test/" });
    await expect(admin.generate(administrator, "adsgram.reward-secret")).rejects.toMatchObject({ code: "forbidden" });
    const first = await admin.generate(owner, "adsgram.reward-secret");
    const value = secrets.get(SECRETS.adsgramRewardSecret) ?? "";
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).toMatchObject({ reveal: `https://api.example.test/api/v1/ads/adsgram/reward/${value}/[userId]`, absolute: true, secret: { source: "base", generated: expect.stringContaining("Reward URL") } });
    expect(JSON.stringify(await admin.list(owner))).not.toContain(value);
    const [entry] = await rolesRepository.recentAudit(10);
    expect(entry).toMatchObject({ action: "secrets.generate", target: "adsgram.reward-secret", before: { source: "none" }, after: { source: "base" } });
    expect(JSON.stringify(entry)).not.toContain(value);
    // Новый адрес сразу заменяет прежний: старый секрет больше не действует.
    await admin.generate(owner, "adsgram.reward-secret");
    expect(secrets.get(SECRETS.adsgramRewardSecret)).not.toBe(value);
  });

  it("без PUBLIC_API_URL адрес — путь, начало дописывает человек; ключ сервиса создать нельзя", async () => {
    const { admin, owner } = await panel();
    await expect(admin.generate(owner, "adsgram.reward-secret")).resolves.toMatchObject({ reveal: expect.stringMatching(/^\/api\/v1\/ads\/adsgram\/reward\/[A-Za-z0-9_-]{43}\/\[userId\]$/), absolute: false });
    await expect(admin.generate(owner, "fx.coingecko-pro")).rejects.toMatchObject({ code: "secret_not_generated" });
  });

  it("сброс без строки в базе — не событие для журнала", async () => {
    const { admin, rolesRepository, owner } = await panel();
    await admin.reset(owner, "fx.coingecko-demo");
    expect(await rolesRepository.recentAudit(10)).toEqual([]);
    await admin.save(owner, "fx.coingecko-demo", DEMO);
    await expect(admin.reset(owner, "fx.coingecko-demo")).resolves.toMatchObject({ source: "none", fingerprint: null });
    expect((await rolesRepository.recentAudit(10)).map((entry) => entry.action).sort()).toEqual(["secrets.reset", "secrets.save"]);
  });
});

describe("ключи курсов: CoinMarketCap, tonapi, erapi (tasks/T-0063)", () => {
  const CMC = "12345678-aaaa-4bbb-8ccc-123456789abc";
  const TONAPI = "AFTONAPIKEYSECRET1234567890";
  const ERAPI = "0123456789abcdef01234567";

  it("три записи в каталоге, ключи — только из панели: окружения у них нет", () => {
    expect([SECRETS.coinmarketcap.key, SECRETS.tonapi.key, SECRETS.erapi.key]).toEqual(["fx.coinmarketcap", "fx.tonapi", "fx.erapi"]);
    const definitions: SecretDefinition[] = [SECRETS.coinmarketcap, SECRETS.tonapi, SECRETS.erapi];
    for (const secret of definitions) {
      expect(secret.fromEnv(config({ FX_COINGECKO_DEMO_KEY: DEMO })), secret.key).toBeNull();
      expect(secret.check, secret.key).toBeDefined();
    }
  });

  it("подсказки — как в решении: CoinMarketCap обязателен для источника, tonapi и erapi необязательны", () => {
    expect(SECRETS.coinmarketcap.title).toBe("Ключ CoinMarketCap");
    expect(SECRETS.coinmarketcap.hint).toBe("Четвёртый источник курса Gram и USDT, тариф Basic — 10 000 кредитов в месяц. Без ключа источника нет");
    expect(SECRETS.tonapi.title).toBe("Ключ tonapi");
    expect(SECRETS.tonapi.hint).toBe("Необязателен: без ключа курс Gram идёт открытым лимитом");
    expect(SECRETS.erapi.title).toBe("Ключ ExchangeRate-API");
    expect(SECRETS.erapi.hint).toBe("Необязателен: без ключа курсы рубля и евро идут открытым адресом");
  });

  it("вид ключа проверяется до записи: свой пример проходит, чужой вид и мусор — нет", () => {
    expect(secretProblem(SECRETS.coinmarketcap, CMC)).toBeNull();
    expect(secretProblem(SECRETS.tonapi, TONAPI)).toBeNull();
    expect(secretProblem(SECRETS.erapi, ERAPI)).toBeNull();
    expect(secretProblem(SECRETS.coinmarketcap, "not-a-key")).toContain(SECRETS.coinmarketcap.example);
    expect(secretProblem(SECRETS.erapi, "abc/../x")).not.toBeNull();
    expect(secretProblem(SECRETS.erapi, `${ERAPI}\n`)).toContain("без пробелов");
    expect(secretProblem(SECRETS.tonapi, "короткий")).not.toBeNull();
  });

  function answeringStatus(status: number) {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("{}", { status });
    }) as typeof fetch;
    return { asked, fetchImpl };
  }

  it("проверка CoinMarketCap — /v1/key/info, который кредиты не тратит", async () => {
    const { asked, fetchImpl } = answeringStatus(200);
    await expect(SECRETS.coinmarketcap.check(CMC, fetchImpl)).resolves.toEqual({ ok: true, message: "CoinMarketCap принял ключ" });
    expect(asked[0]?.url).toBe("https://pro-api.coinmarketcap.com/v1/key/info");
    expect(asked[0]?.headers).toMatchObject({ "X-CMC_PRO_API_KEY": CMC });
    const refused = answeringStatus(401);
    await expect(SECRETS.coinmarketcap.check(CMC, refused.fetchImpl)).resolves.toMatchObject({ ok: false, message: expect.stringContaining("не принял ключ (401)") });
  });

  it("проверка erapi — /v6/<ключ>/quota; отказ — «не принял», перегрузка — «не проверен»", async () => {
    const { asked, fetchImpl } = answeringStatus(200);
    await expect(SECRETS.erapi.check(ERAPI, fetchImpl)).resolves.toEqual({ ok: true, message: "ExchangeRate-API принял ключ" });
    expect(asked[0]?.url).toBe(`https://v6.exchangerate-api.com/v6/${ERAPI}/quota`);
    await expect(SECRETS.erapi.check(ERAPI, answeringStatus(403).fetchImpl)).resolves.toMatchObject({ ok: false, message: expect.stringContaining("не принял ключ (403)") });
    await expect(SECRETS.erapi.check(ERAPI, answeringStatus(429).fetchImpl)).resolves.toMatchObject({ ok: false, message: expect.stringContaining("ключ не проверен") });
  });

  it("ForexRateAPI: ключ в каталоге, шаблон отсекает мусор, проверка — /v1/usage с заголовком", async () => {
    const KEY = "0123456789abcdef0123456789abcdef";
    expect(SECRETS.forexrateapi.key).toBe("fx.forexrateapi");
    expect(SECRETS.forexrateapi.fromEnv()).toBeNull();
    expect(secretProblem(SECRETS.forexrateapi, SECRETS.forexrateapi.example)).toBeNull();
    for (const bad of ["", "короткий", "abc123", `${KEY} x`, `${KEY}\n`]) expect(secretProblem(SECRETS.forexrateapi, bad), bad).not.toBeNull();
    const { asked, fetchImpl } = answeringStatus(200);
    await expect(SECRETS.forexrateapi.check(KEY, fetchImpl)).resolves.toMatchObject({ ok: true });
    expect(asked[0]?.url).toBe("https://api.forexrateapi.com/v1/usage");
    expect(asked[0]?.url).not.toContain(KEY);
    expect(asked[0]?.headers).toMatchObject({ "X-API-KEY": KEY });
  });

  it("проверка tonapi — запросом курса с заголовком Bearer", async () => {
    const { asked, fetchImpl } = answeringStatus(200);
    await expect(SECRETS.tonapi.check(TONAPI, fetchImpl)).resolves.toEqual({ ok: true, message: "tonapi принял ключ" });
    expect(asked[0]?.url).toBe("https://tonapi.io/v2/rates?tokens=ton&currencies=usd");
    expect(asked[0]?.headers).toMatchObject({ Authorization: `Bearer ${TONAPI}` });
    await expect(SECRETS.tonapi.check(TONAPI, answeringStatus(401).fetchImpl)).resolves.toMatchObject({ ok: false });
  });

  it("сторож: любой ключ erapi, который принимает шаблон, журнал исходящих прячет — и в опросе, и в проверке", () => {
    // Ключ ExchangeRate-API уходит в путь адреса, а `safePath` прячет только длинные сегменты. Пока
    // шаблон пускает ключ короче, чем прячет журнал, ключ ляжет в `outbound_call.path` открытым текстом.
    const alphabet = "0123456789abcdefABCDEFghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ";
    const accepted: string[] = [];
    for (let length = 1; length <= 100; length++) {
      for (const char of [alphabet[0], alphabet[10], alphabet[16], alphabet[20], alphabet[40], alphabet[60]]) {
        const key = (char ?? "0").repeat(length);
        if (SECRETS.erapi.pattern.test(key)) accepted.push(key);
      }
    }
    expect(accepted.length).toBeGreaterThan(0);
    const shortest = accepted.reduce((a, b) => (b.length < a.length ? b : a));
    const longest = accepted.reduce((a, b) => (b.length > a.length ? b : a));
    for (const key of [shortest, longest, ...accepted]) {
      for (const url of [`https://v6.exchangerate-api.com/v6/${key}/latest/USD`, `https://v6.exchangerate-api.com/v6/${key}/quota`]) {
        expect(safePath(url).path, `ключ из ${String(key.length)} знаков`).not.toContain(key);
      }
    }
    expect(safePath(`https://v6.exchangerate-api.com/v6/${shortest}/quota`).path).toBe("/v6/***/quota");
  });

  it("ключ erapi — 24 шестнадцатеричных знака, как у сервиса: короче, длиннее и с чужими знаками шаблон не принимает", () => {
    const valid = "0123456789abcdef01234567";
    expect(SECRETS.erapi.pattern.test(valid)).toBe(true);
    expect(SECRETS.erapi.pattern.test(valid.toUpperCase())).toBe(true);
    expect(SECRETS.erapi.pattern.test(valid.slice(1))).toBe(false);
    expect(SECRETS.erapi.pattern.test(`${valid}0`)).toBe(false);
    expect(SECRETS.erapi.pattern.test(`${valid.slice(1)}g`)).toBe(false);
    expect(secretProblem(SECRETS.erapi, "abcdef12")).toContain(SECRETS.erapi.example);
  });

  it("сервис не ответил — ключ не проверен, а не «неверный»", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(SECRETS.coinmarketcap.check(CMC, down)).resolves.toEqual({ ok: false, message: "CoinMarketCap недоступен с сервера — ключ не проверен" });
  });

  it("источники берут ключи на каждом проходе: CoinMarketCap появляется с ключом, tonapi и erapi переходят на свой тариф", async () => {
    const { service } = setup();
    const byId = () => new Map(fxSources(service).map((source) => [source.id, source]));
    expect(byId().has("coinmarketcap")).toBe(false);
    expect(byId().get("tonapi")?.tariff.name).toBe("keyless");
    expect(byId().get("erapi")?.tariff.name).toBe("open-access");

    await service.write(SECRETS.coinmarketcap, CMC, ACTOR_ID);
    await service.write(SECRETS.tonapi, TONAPI, ACTOR_ID);
    await service.write(SECRETS.erapi, ERAPI, ACTOR_ID);
    expect(byId().get("coinmarketcap")?.tariff.name).toBe("basic");
    expect(byId().get("tonapi")?.tariff.name).toBe("keyed");
    expect(byId().get("erapi")?.tariff.name).toBe("keyed");
  });
});

