import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { classifyClient } from "../src/modules/attribution/client-class.js";
import { ipPrefix } from "../src/modules/attribution/ip-prefix.js";
import { RedisSessionDedupe, type SessionDedupe } from "../src/modules/attribution/session-dedupe.js";
import { SessionRecorder } from "../src/modules/attribution/session-recorder.js";
import type { AcquisitionView, SessionRecord, SessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { telegramLoginSchema } from "../src/modules/auth/dto/auth.dto.js";
import type { Redis } from "ioredis";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { launchFor, signInitData } from "./helpers/init-data.js";
import { MemoryAccountRepository, MemoryRefreshStore } from "./helpers/memory-auth.js";
import { launchVerifiersFor } from "../src/platforms/platforms.module.js";

/**
 * Сессии и атрибуция (docs/34-stage3-plan.md, WP6). Проверяется то, где запись
 * сессий обычно ломается: несколько сессий на один запуск, параметр запуска
 * из тела запроса вместо подписи, вход, который ждёт записи, и сессия,
 * потерянная из-за упавшего Redis.
 */

const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
}

class MemorySessions implements SessionsRepository {
  readonly recorded: SessionRecord[] = [];
  failing = false;
  async record(session: SessionRecord): Promise<"recorded" | "duplicate"> {
    if (this.failing) throw new Error("база недоступна");
    this.recorded.push(session);
    return "recorded";
  }
  async acquisition(): Promise<AcquisitionView | null> {
    return null;
  }
}

/** Окно дедупликации в памяти — со смыслом ключа Redis: тот же аккаунт и параметр. */
class MemoryDedupe implements SessionDedupe {
  private readonly seen = new Set<string>();
  async claim(accountId: string, startParam: string | null): Promise<boolean> {
    const key = `${accountId}:${startParam ?? ""}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

function login(patch: Partial<LoginEvent> = {}): LoginEvent {
  return {
    accountId: randomUUID(),
    platform: "telegram",
    place: "miniapp",
    startParam: parseStartParam("c-Ab12Cd34"),
    created: false,
    at: new Date(NOW),
    ip: "203.0.113.57",
    userAgent: "Mozilla/5.0 (Linux; Android 14) Telegram-Android/11.2",
    client: { platform: "android", version: "8.0" },
    reason: "launch",
    ...patch,
  };
}

function recorder(sessions = new MemorySessions(), dedupe: SessionDedupe = new MemoryDedupe()): { recorder: SessionRecorder; sessions: MemorySessions } {
  // Очередь не поднята — как при недоступном Redis: сессия пишется сразу.
  return { recorder: new SessionRecorder(config(), new AuthHooks(), sessions, dedupe), sessions };
}

describe("класс клиента", () => {
  it("верит платформе клиента, а ОС уточняет по User-Agent только там, где платформа её не называет", () => {
    expect(classifyClient({ platform: "android", version: "8.0" }, null)).toEqual({ deviceClass: "mobile", os: "android", clientPlatform: "android", clientVersion: "8.0" });
    expect(classifyClient({ platform: "tdesktop", version: "7.10" }, "Mozilla/5.0 (Windows NT 10.0)")).toMatchObject({ deviceClass: "desktop", os: "windows" });
    expect(classifyClient({ platform: "weba", version: null }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toMatchObject({ deviceClass: "web", os: "macos" });
  });

  it("без платформы клиента мобильным считает только то, что так и называется", () => {
    expect(classifyClient(null, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toMatchObject({ deviceClass: "mobile", os: "ios" });
    expect(classifyClient(null, "Mozilla/5.0 (X11; Linux x86_64)")).toMatchObject({ deviceClass: "unknown", os: "linux" });
    expect(classifyClient(null, null)).toMatchObject({ deviceClass: "unknown", os: "unknown" });
  });

  it("мусор в подсказке не запоминается", () => {
    expect(classifyClient({ platform: "<script>", version: "1; DROP" }, null)).toMatchObject({ clientPlatform: null, clientVersion: null, deviceClass: "unknown" });
  });
});

describe("подсеть вместо адреса", () => {
  it("IPv4 — до /24, IPv4 в обёртке IPv6 — так же", () => {
    expect(ipPrefix("203.0.113.57")).toBe("203.0.113.0/24");
    expect(ipPrefix("::ffff:203.0.113.57")).toBe("203.0.113.0/24");
  });

  it("IPv6 — до /48, в том числе сокращённый", () => {
    expect(ipPrefix("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("2001:db8::1")).toBe("2001:db8:0::/48");
  });

  it("не адрес — ничего", () => {
    for (const value of [null, "", "unknown", "999.1.1.1"]) expect(ipPrefix(value)).toBeNull();
  });
});

describe("сессия на запуск", () => {
  it("пишет сессию с источником, классом устройства и подсетью, но без адреса и строки UA", async () => {
    const { recorder: subject, sessions } = recorder();

    await subject.record(login());

    expect(sessions.recorded).toHaveLength(1);
    expect(sessions.recorded[0]).toMatchObject({ startKind: "click", startRef: "Ab12Cd34", deviceClass: "mobile", os: "android", ipPrefix: "203.0.113.0/24" });
    expect(JSON.stringify(sessions.recorded[0])).not.toContain("203.0.113.57");
    expect(JSON.stringify(sessions.recorded[0])).not.toContain("Mozilla");
  });

  it("повторный вход того же запуска — одна сессия, а по новой ссылке — новая", async () => {
    const { recorder: subject, sessions } = recorder();
    const first = login();

    await subject.record(first);
    await subject.record({ ...first, at: new Date(NOW + 5_000) });
    await subject.record({ ...first, startParam: parseStartParam("invite"), at: new Date(NOW + 8_000) });

    expect(sessions.recorded.map((session) => session.startKind)).toEqual(["click", "invite"]);
  });

  it("повторный вход посреди работы сессией не считается", async () => {
    const { recorder: subject, sessions } = recorder();

    await subject.record(login({ reason: "reauth" }));

    expect(sessions.recorded).toEqual([]);
  });

  it("упавшая запись не роняет вход", async () => {
    const sessions = new MemorySessions();
    sessions.failing = true;

    await expect(recorder(sessions).recorder.record(login())).resolves.toBeUndefined();
  });

  it("недоступный Redis — сессия всё равно пишется: лишняя лучше потерянной", async () => {
    const broken = { set: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

    await expect(new RedisSessionDedupe(broken).claim(randomUUID(), null)).resolves.toBe(true);
  });
});

describe("вход и сессия", () => {
  const BOT_TOKEN = AUTH_ENV.TELEGRAM_BOT_TOKEN;

  it("параметр запуска — из подписанных данных: в теле запроса схема его отбрасывает", () => {
    const parsed = telegramLoginSchema.parse({ initData: "x", startParam: "c-Stolen1234", start_param: "c-Stolen1234" });

    expect(parsed).not.toHaveProperty("startParam");
    expect(parsed).not.toHaveProperty("start_param");
  });

  it("вход сообщает о запуске с разобранным параметром и не ждёт слушателей", async () => {
    const hooks = new AuthHooks();
    const heard: LoginEvent[] = [];
    hooks.onLogin("test", async (event) => void heard.push(event));
    // Слушатель, который не отвечает никогда: вход обязан пройти и без него.
    hooks.onLogin("stuck", () => new Promise<void>(() => undefined));
    const service = new AuthService(config(), new MemoryAccountRepository(), new MemoryRefreshStore(), hooks, launchVerifiersFor(config()));
    const initData = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000) - 60), user: JSON.stringify({ id: 555_000_111, first_name: "Анна" }), start_param: "c-Ab12Cd34" },
      BOT_TOKEN,
    );

    const result = await service.loginWithLaunch("telegram", initData, { ip: "203.0.113.57", userAgent: null, client: null, reason: "launch" });

    expect(result.startParam).toEqual({ kind: "click", raw: "c-Ab12Cd34", ref: "Ab12Cd34" });
    expect(heard[0]).toMatchObject({ place: "miniapp", created: true, reason: "launch", startParam: { kind: "click" } });
  });

  it("запуск без параметра — органический", async () => {
    const service = new AuthService(config(), new MemoryAccountRepository(), new MemoryRefreshStore(), new AuthHooks(), launchVerifiersFor(config()));

    await expect(service.loginWithLaunch("telegram", launchFor(555, BOT_TOKEN))).resolves.toMatchObject({ startParam: { kind: "organic" } });
  });
});
