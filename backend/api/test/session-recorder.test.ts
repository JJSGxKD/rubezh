import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { SessionRecorder, sessionOf } from "../src/modules/attribution/session-recorder.js";
import type { AcquisitionView, SessionRecord, SessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import type { AutoSourcesService } from "../src/modules/links/auto-sources.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Автоисточник при записи сессии (Р116, T-0179): `process` заводит источник только после
 * настоящей записи. Повтор задания очереди — «duplicate» — ни источник, ни счётчики не двигает,
 * сбой источника сессию не откатывает и задание не роняет.
 */

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

class MemorySessions implements SessionsRepository {
  readonly recorded: SessionRecord[] = [];
  outcome: "recorded" | "duplicate" = "recorded";
  async record(session: SessionRecord): Promise<"recorded" | "duplicate"> {
    if (this.outcome === "recorded") this.recorded.push(session);
    return this.outcome;
  }
  async acquisition(): Promise<AcquisitionView | null> {
    return null;
  }
  async recentIpPrefixes(): Promise<string[]> {
    return [];
  }
  async lastSessionBefore(): Promise<Date | null> {
    return null;
  }
}

function login(startParam: string | null, patch: Partial<LoginEvent> = {}): LoginEvent {
  return {
    accountId: randomUUID(),
    platform: "telegram",
    place: "miniapp",
    startParam: parseStartParam(startParam),
    created: false,
    at: new Date(NOW),
    ip: "203.0.113.57",
    userAgent: "Mozilla/5.0 (Linux; Android 14)",
    client: { platform: "android", version: "8.0" },
    reason: "launch",
    ...patch,
  };
}

function subject(sessions: SessionsRepository, autoSources: Pick<AutoSourcesService, "onSession"> | null) {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
  return new SessionRecorder(config, new AuthHooks(), sessions, { claim: async () => true }, null, autoSources as AutoSourcesService | null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("автоисточник при записи сессии", () => {
  it("process вызывает onSession только при «recorded»: параметр, платформа и время — из сессии", async () => {
    const sessions = new MemorySessions();
    const onSession = vi.fn(async () => "created" as const);
    const recorder = subject(sessions, { onSession });
    const session = sessionOf(login("src-tgads_cmp-oct", { platform: "vk" }));

    await recorder.process({ data: { session } });

    expect(sessions.recorded).toHaveLength(1);
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith({ startParam: "src-tgads_cmp-oct", platform: "vk", startedAt: new Date(NOW).toISOString() });
  });

  it("повтор задания («duplicate») ни источник, ни счётчики не двигает", async () => {
    const sessions = new MemorySessions();
    sessions.outcome = "duplicate";
    const onSession = vi.fn(async () => "created" as const);

    await subject(sessions, { onSession }).process({ data: { session: sessionOf(login("src-tgads_cmp-oct")) } });

    expect(onSession).not.toHaveBeenCalled();
  });

  it("ошибка автоисточника: process не падает, сессия записана, в лог — warn без значений пар", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const sessions = new MemorySessions();
    const onSession = vi.fn(async () => {
      throw new Error("база недоступна");
    });

    await expect(subject(sessions, { onSession }).process({ data: { session: sessionOf(login("src-tgads_cmp-secretvalue")) } })).resolves.toBeUndefined();

    expect(sessions.recorded).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ module: "attribution", event: "auto_source_failed", reason: "база недоступна" });
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secretvalue");
  });

  it("без модуля ссылок запись сессии идёт как раньше", async () => {
    const sessions = new MemorySessions();

    await expect(subject(sessions, null).process({ data: { session: sessionOf(login("src-tgads_cmp-oct")) } })).resolves.toBeUndefined();

    expect(sessions.recorded).toHaveLength(1);
  });

  it("очереди нет — сессия пишется сразу, и источник заводится так же", async () => {
    const sessions = new MemorySessions();
    const onSession = vi.fn(async () => "created" as const);

    await subject(sessions, { onSession }).record(login("src-tgads_cmp-oct"));

    expect(sessions.recorded).toHaveLength(1);
    expect(onSession).toHaveBeenCalledTimes(1);
  });

  it("запуск без пар тоже доходит до onSession: решает сервис ссылок, а не рекордер", async () => {
    const sessions = new MemorySessions();
    const onSession = vi.fn(async () => null);

    await subject(sessions, { onSession }).process({ data: { session: sessionOf(login("c-AbCdEf123456")) } });

    expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ startParam: "c-AbCdEf123456" }));
  });
});
