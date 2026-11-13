import "reflect-metadata";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XrayCoreBlock } from "@bh/proxy-kit";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { OUTBOUND_SERVICES } from "../src/infra/outbound/outbound-services.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { AdminXrayCoreController } from "../src/modules/admin/admin-xray-core.controller.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { XrayReleases } from "../src/modules/proxies/xray-core/xray-core-releases.js";
import { parseCoreStatus, readCoreStatus } from "../src/modules/proxies/xray-core/xray-core-status.js";
import { XRAY_UPDATE_TARGET } from "../src/modules/proxies/xray-core/xray-core-target.js";
import { XrayCoreUpdater } from "../src/modules/proxies/xray-core/xray-core-update.js";
import { XrayCoreService, type CompatOptions, type UpdateBlock, type XrayCoreView } from "../src/modules/proxies/xray-core/xray-core.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SECRETS, secretProblem, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Сервер «Ядра Xray» (docs/35-stage4-plan.md Р202, tasks/T-0416): запущенная
 * версия из файла статуса, свежий выпуск XTLS с кэшем, совместимость из
 * `@bh/proxy-kit` и запуск workflow обновления. GitHub, Redis и часы —
 * подмены; файл статуса — настоящий, во временном каталоге.
 */

const START = Date.parse("2026-11-13T12:00:00.000Z");
const TOKEN = `github_pat_${"A1".repeat(40)}`;
const RELEASES_URL = "https://api.github.com/repos/XTLS/Xray-core/releases/latest";
const WORKFLOW_URL = `https://api.github.com/repos/${XRAY_UPDATE_TARGET.repository}/actions/workflows/${XRAY_UPDATE_TARGET.workflow}`;
const DISPATCH_URL = `${WORKFLOW_URL}/dispatches`;
const RUNS_URL = `${WORKFLOW_URL}/runs?per_page=1&event=workflow_dispatch`;
const ACTOR: AccountRef = { accountId: "acc-owner", platform: "telegram", platformUserId: "700000" };

const dir = mkdtempSync(join(tmpdir(), "xray-core-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let fileIndex = 0;
function statusFile(text: string | null): string {
  fileIndex += 1;
  const path = join(dir, `core-${String(fileIndex)}`);
  if (text !== null) writeFileSync(path, text);
  return path;
}
const CORE_26_10_31 = "version=26.10.31\nstarted=2026-11-10T09:15:02Z\n";

const releaseBody = (tag: string, patch: Record<string, unknown> = {}): string =>
  JSON.stringify({ tag_name: tag, html_url: `https://github.com/XTLS/Xray-core/releases/tag/${tag}`, published_at: "2026-11-12T08:00:00Z", prerelease: false, draft: false, ...patch });
const runBody = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({ workflow_runs: [{ status: "completed", conclusion: "success", html_url: "https://github.com/JJSGxKD/rubezh/actions/runs/1", created_at: "2026-11-12T10:00:00Z", display_title: "Обновление ядра Xray до 26.11.1", ...patch }] });

/** Часы одни на Redis, выпуск и запуск: срок ключей и «через 61 секунду» идут от них. */
class Clock {
  ms = START;
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Redis в памяти: `GET`, `SET … PX [NX]`, `PTTL`, `DEL` со сроками по общим часам; `broken` — не отвечает. */
class MemoryRedis {
  broken = false;
  readonly values = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly clock: Clock) {}

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.values.get(key);
    if (entry !== undefined && entry.expiresAt <= this.clock.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }
  private check(): void {
    if (this.broken) throw new Error("connection refused");
  }
  async get(key: string): Promise<string | null> {
    this.check();
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, _mode: "PX", ttlMs: number, nx?: "NX"): Promise<"OK" | null> {
    this.check();
    if (nx === "NX" && this.live(key) !== undefined) return null;
    this.values.set(key, { value, expiresAt: this.clock.now() + ttlMs });
    return "OK";
  }
  async pttl(key: string): Promise<number> {
    this.check();
    const entry = this.live(key);
    return entry === undefined ? -2 : entry.expiresAt - this.clock.now();
  }
  async del(key: string): Promise<number> {
    this.check();
    return this.values.delete(key) ? 1 : 0;
  }
  async eval(): Promise<unknown> {
    throw new Error("connection refused");
  }
  has(key: string): boolean {
    return this.live(key) !== undefined;
  }
}

type Responder = (init: RequestInit | undefined) => Response | Promise<Response>;
const timeoutError = (): Error => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** GitHub: ответ на каждый из трёх адресов задаётся отдельно; всё прочее — 404. */
class FakeGitHub {
  release: Responder = () => new Response(releaseBody("v26.11.5"), { status: 200 });
  dispatch: Responder = () => new Response(null, { status: 204 });
  runs: Responder = () => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  readonly calls: { url: string; init: RequestInit | undefined }[] = [];
  readonly fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({ url, init });
    if (url === RELEASES_URL) return await this.release(init);
    if (url === DISPATCH_URL) return await this.dispatch(init);
    if (url === RUNS_URL) return await this.runs(init);
    return new Response("{}", { status: 404 });
  });
  callsTo(url: string): { url: string; init: RequestInit | undefined }[] {
    return this.calls.filter((call) => call.url === url);
  }
}

const noKeys: SecretsReader = { get: () => null };
const withToken = (token: string | null): SecretsReader => ({ get: (secret: SecretDefinition) => (secret.key === SECRETS.githubXrayUpdate.key ? token : null) });

interface Rig {
  clock: Clock;
  redis: MemoryRedis;
  github: FakeGitHub;
  releases: XrayReleases;
  updater: XrayCoreUpdater;
  service: XrayCoreService;
  roles: { require: ReturnType<typeof vi.fn>; audit: ReturnType<typeof vi.fn> };
  logs: string[];
}

function rig(options: { status?: string | null; token?: string | null; compat?: CompatOptions } = {}): Rig {
  const clock = new Clock();
  const redis = new MemoryRedis(clock);
  const github = new FakeGitHub();
  const releases = new XrayReleases({ redis, fetch: github.fetch, now: clock.now });
  const updater = new XrayCoreUpdater({ redis, fetch: github.fetch, now: clock.now });
  const roles = { require: vi.fn(async () => undefined), audit: vi.fn(async () => undefined) };
  const logs: string[] = [];
  const service = new XrayCoreService({
    roles,
    secrets: options.token === null ? noKeys : withToken(options.token ?? TOKEN),
    releases,
    updater,
    statusPath: statusFile(options.status === undefined ? CORE_26_10_31 : options.status),
    compat: options.compat ?? { min: "26.10.31", max: "26.10.31", blocks: [] },
    log: (line) => logs.push(line),
    now: clock.now,
  });
  return { clock, redis, github, releases, updater, service, roles, logs };
}

const failure = (status: number, message: string): Record<string, unknown> => ({ status, message: expect.stringContaining(message) as unknown });

describe("файл статуса ядра", () => {
  it("две строки version и started: версия и время запуска", () => {
    const status = parseCoreStatus("version=26.10.31\nstarted=2026-11-10T09:15:02Z\n");
    expect(status).toEqual({ state: "ok", version: "26.10.31", startedAt: new Date("2026-11-10T09:15:02Z") });
  });

  it("CRLF, пустые строки и лишний ключ не мешают", () => {
    expect(parseCoreStatus("foo=bar\r\n\r\nversion=26.10.31\r\nstarted=2026-11-10T09:15:02Z\r\n")).toEqual({ state: "ok", version: "26.10.31", startedAt: new Date("2026-11-10T09:15:02Z") });
  });

  it("версия с ведущей v хранится нормализованной", () => {
    expect(parseCoreStatus("version=v26.10.31\n")).toMatchObject({ state: "ok", version: "26.10.31" });
  });

  it.each([["version=\nstarted=2026-11-10T09:15:02Z"], ["version=abc"], ["started=2026-11-10T09:15:02Z"], [""]])("версия не разобрана (%j) — unreadable", (text) => {
    expect(parseCoreStatus(text)).toEqual({ state: "unreadable" });
  });

  it.each([["started=вчера"], ["started=2026-11-10 09:15:02"], ["started=2026-11-10T09:15:02+03:00"], ["started="]])("время не ISO с Z (%j) — версия засчитана, время null", (started) => {
    expect(parseCoreStatus(`version=26.10.31\n${started}\n`)).toEqual({ state: "ok", version: "26.10.31", startedAt: null });
  });

  it("читается из настоящего файла", async () => {
    expect(await readCoreStatus(statusFile(CORE_26_10_31))).toMatchObject({ state: "ok", version: "26.10.31" });
  });

  it("файла нет — missing", async () => {
    expect(await readCoreStatus(join(dir, "нет-такого"))).toEqual({ state: "missing" });
  });

  it("файл 2 КБ — unreadable", async () => {
    expect(await readCoreStatus(statusFile(`version=26.10.31\n${"x".repeat(2_048)}`))).toEqual({ state: "unreadable" });
  });

  it("ошибка чтения, кроме ENOENT (путь — каталог), — unreadable, а не missing", async () => {
    const folder = join(dir, "папка");
    mkdirSync(folder, { recursive: true });
    expect(await readCoreStatus(folder)).toEqual({ state: "unreadable" });
  });
});

describe("свежий выпуск", () => {
  it("v26.11.5 разбирается, второй вызов в течение 6 часов сети не трогает", async () => {
    const r = rig();
    const first = await r.releases.latest();
    expect(first.error).toBeNull();
    expect(first.release).toEqual({ version: "26.11.5", publishedAt: "2026-11-12T08:00:00.000Z", url: "https://github.com/XTLS/Xray-core/releases/tag/v26.11.5", checkedAt: new Date(START).toISOString() });

    r.clock.advance(5 * 3_600_000);
    expect((await r.releases.latest()).release?.version).toBe("26.11.5");
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(1);

    r.clock.advance(2 * 3_600_000);
    await r.releases.latest();
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(2);
  });

  it("запрос без authorization, с accept, x-github-api-version и user-agent", async () => {
    const r = rig();
    await r.releases.latest();
    const headers = new Headers(r.github.callsTo(RELEASES_URL)[0]?.init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("rubezh-api");
    expect(r.github.callsTo(RELEASES_URL)[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("prerelease и draft — выпуска нет", async () => {
    for (const patch of [{ prerelease: true }, { draft: true }]) {
      const r = rig();
      r.github.release = () => new Response(releaseBody("v26.11.5", patch));
      const found = await r.releases.latest();
      expect(found.release).toBeNull();
    }
  });

  it("html_url на другой репозиторий — «Ответ GitHub не разобран»", async () => {
    const r = rig();
    r.github.release = () => new Response(releaseBody("v26.11.5", { html_url: "https://github.com/evil/Xray-core/releases/tag/v26.11.5" }));
    expect(await r.releases.latest()).toEqual({ release: null, error: "Ответ GitHub не разобран" });
  });

  it("не JSON и нехватка полей — тоже «Ответ GitHub не разобран»", async () => {
    for (const body of ["<html>", JSON.stringify({ tag_name: "v26.11.5" })]) {
      const r = rig();
      r.github.release = () => new Response(body);
      expect((await r.releases.latest()).error).toBe("Ответ GitHub не разобран");
    }
  });

  it("метка nightly — «Метка выпуска не распознана: nightly», метка режется до 32 знаков", async () => {
    const r = rig();
    r.github.release = () => new Response(releaseBody("nightly"));
    expect(await r.releases.latest()).toEqual({ release: null, error: "Метка выпуска не распознана: nightly" });

    const long = rig();
    long.github.release = () => new Response(releaseBody("x".repeat(80)));
    expect((await long.releases.latest()).error).toBe(`Метка выпуска не распознана: ${"x".repeat(32)}`);
  });

  it("таймаут — «GitHub не ответил за 5 секунд», ошибка кэшируется на 10 минут", async () => {
    const r = rig();
    r.github.release = () => Promise.reject(timeoutError());
    expect(await r.releases.latest()).toEqual({ release: null, error: "GitHub не ответил за 5 секунд" });
    expect((await r.releases.latest()).error).toBe("GitHub не ответил за 5 секунд");
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(1);

    r.clock.advance(601_000);
    r.github.release = () => new Response(releaseBody("v26.11.5"));
    expect((await r.releases.latest()).release?.version).toBe("26.11.5");
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(2);
  });

  it("тексты ошибок: сеть, код ответа, лимит запросов", async () => {
    const cases: [Responder, string][] = [
      [() => Promise.reject(new TypeError("fetch failed")), "GitHub недоступен с сервера"],
      [() => new Response("", { status: 500 }), "GitHub ответил 500"],
      [() => new Response("", { status: 429 }), "GitHub: слишком много запросов — проверим позже"],
      [() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "GitHub: слишком много запросов — проверим позже"],
      [() => new Response("", { status: 403 }), "GitHub ответил 403"],
    ];
    for (const [responder, text] of cases) {
      const r = rig();
      r.github.release = responder;
      expect((await r.releases.latest()).error, text).toBe(text);
    }
  });

  it("«Проверить сейчас» дважды за минуту — второй 429; через 61 секунду проходит и переписывает кэш", async () => {
    const r = rig();
    await r.releases.latest();
    await r.releases.refresh();
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(2);

    await expect(r.releases.refresh()).rejects.toMatchObject({ status: 429, message: "Проверять выпуск можно раз в минуту" });
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(2);

    r.clock.advance(61_000);
    r.github.release = () => new Response(releaseBody("v26.11.6"));
    const found = await r.releases.refresh();
    expect(found.release?.version).toBe("26.11.6");
    expect((await r.releases.latest()).release?.version).toBe("26.11.6");
  });

  it("сбой при «Проверить сейчас» ложится в кэш ошибки и виден дальше", async () => {
    const r = rig();
    await r.releases.latest();
    r.github.release = () => new Response("", { status: 500 });
    r.clock.advance(61_000);
    expect((await r.releases.refresh()).error).toBe("GitHub ответил 500");
    expect((await r.releases.latest()).error).toBe("GitHub ответил 500");
  });

  it("Redis бросает — latest() всё равно отвечает, идёт в сеть", async () => {
    const r = rig();
    r.redis.broken = true;
    expect((await r.releases.latest()).release?.version).toBe("26.11.5");
    expect((await r.releases.latest()).release?.version).toBe("26.11.5");
    expect(r.github.callsTo(RELEASES_URL)).toHaveLength(2);
  });

  it("Redis бросает — «Проверить сейчас» не закрыта (ограничение без Redis не поставить)", async () => {
    const r = rig();
    r.redis.broken = true;
    expect((await r.releases.refresh()).release?.version).toBe("26.11.5");
  });
});

describe("запуск обновления", () => {
  async function ready(r: Rig): Promise<void> {
    await r.service.view(ACTOR);
  }

  it("выпуск 26.11.5, ключ есть, запусков нет: POST dispatches на dev с версией, аудит и лог без ключа", async () => {
    const r = rig();
    await ready(r);

    const view = await r.service.update(ACTOR, "26.11.5");

    const calls = r.github.callsTo(DISPATCH_URL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ref: "dev", inputs: { version: "26.11.5" } });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("rubezh-api");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);

    expect(r.roles.require).toHaveBeenCalledWith(ACTOR, "proxies.edit");
    expect(r.roles.audit).toHaveBeenCalledWith({ actorAccountId: ACTOR.accountId, action: "proxies.xray_core.update", target: "26.11.5", after: { version: "26.11.5", running: "26.10.31" } });
    expect(r.logs).toHaveLength(1);
    expect(JSON.parse(r.logs[0] as string)).toEqual({ module: "xray-core", event: "update_dispatched", version: "26.11.5", actor: ACTOR.accountId });
    expect(JSON.stringify({ view, logs: r.logs, audit: r.roles.audit.mock.calls })).not.toContain("github_pat_");
    expect(view.update.blockedBy).toBe("locked");
    expect(view.update.lockedUntil).toBe(new Date(START + 600_000).toISOString());
  });

  it("версия из тела не совпала с кэшем — 409 «Выпуск сменился», GitHub не зовётся", async () => {
    const r = rig();
    await ready(r);
    await expect(r.service.update(ACTOR, "26.11.6")).rejects.toMatchObject({ ...failure(409, "Выпуск сменился — обновите страницу"), code: "xray_release_changed" });
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(0);
  });

  it("второй update сразу после первого — 409 замка, запрос к GitHub один", async () => {
    const r = rig();
    await ready(r);
    await r.service.update(ACTOR, "26.11.5");
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject(failure(409, "Обновление уже запускали в 12:00 по UTC — повторить можно через 10 минут"));
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(1);

    r.clock.advance(601_000);
    await r.service.update(ACTOR, "26.11.5");
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(2);
  });

  it.each([
    [401, 502, "не принял ключ github.xray-update"],
    [403, 502, "Actions: Read and write"],
    [404, 502, "Workflow xray-bump.yml не найден"],
    [422, 502, "GitHub отклонил запуск: Workflow does not have workflow_dispatch"],
  ])("GitHub %i — %i, замок снят: следующий update снова идёт в GitHub", async (code, status, text) => {
    const r = rig();
    await ready(r);
    r.github.dispatch = () => new Response(JSON.stringify({ message: "Workflow does not have workflow_dispatch trigger" }), { status: code });

    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject(failure(status, text));
    expect(r.redis.has("xray-core:update:lock")).toBe(false);
    r.github.dispatch = () => new Response(null, { status: 204 });
    await r.service.update(ACTOR, "26.11.5");
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(2);
  });

  it("сообщение GitHub при 422 режется до 200 знаков", async () => {
    const r = rig();
    await ready(r);
    r.github.dispatch = () => new Response(JSON.stringify({ message: "я".repeat(500) }), { status: 422 });
    const error = (await r.service.update(ACTOR, "26.11.5").catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(`GitHub отклонил запуск: ${"я".repeat(200)}`);
  });

  it("таймаут GitHub — 504, замок остался", async () => {
    const r = rig();
    await ready(r);
    r.github.dispatch = () => Promise.reject(timeoutError());
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject(failure(504, "GitHub не ответил за 5 секунд — проверьте запуски через минуту"));
    expect(r.redis.has("xray-core:update:lock")).toBe(true);
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ status: 409 });
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(1);
  });

  it("сеть упала или GitHub ответил 500 — замок остался: неизвестно, ушёл ли запуск", async () => {
    for (const responder of [() => Promise.reject(new TypeError("fetch failed")), () => new Response("", { status: 500 })] as Responder[]) {
      const r = rig();
      await ready(r);
      r.github.dispatch = responder;
      await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ status: 502 });
      expect(r.redis.has("xray-core:update:lock")).toBe(true);
    }
  });

  it("Redis недоступен — 503, запроса к GitHub нет", async () => {
    const r = rig();
    await ready(r);
    await r.service.view(ACTOR);
    r.redis.broken = true;
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject(failure(503, "Не удалось взять замок запуска — повторите позже"));
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(0);
  });

  it("последний запуск in_progress — 409 running", async () => {
    const r = rig();
    r.github.runs = () => new Response(runBody({ status: "in_progress", conclusion: null }));
    await ready(r);
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ ...failure(409, "Обновление уже идёт"), code: "xray_running" });
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(0);
  });

  it("выпуск в блоке — 409 с причиной блока", async () => {
    const blocks: XrayCoreBlock[] = [{ from: "26.11.5", until: null, reason: "Поменялся формат routing" }];
    const r = rig({ compat: { min: "26.10.31", max: "26.10.31", blocks } });
    await ready(r);
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ ...failure(409, "Перейти нельзя, нужно обновить код: Поменялся формат routing"), code: "xray_blocked" });
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(0);
  });

  it("запущенная = выпуск — 409 up_to_date; выпуск не новее MAX — in_code", async () => {
    const same = rig({ status: "version=26.11.5\n" });
    await expect(same.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ ...failure(409, "Ядро уже этой версии"), code: "xray_up_to_date" });

    const sameAsMax = rig();
    sameAsMax.github.release = () => new Response(releaseBody("v26.10.31"));
    await expect(sameAsMax.service.update(ACTOR, "26.10.31")).rejects.toMatchObject({ ...failure(409, "Ядро уже этой версии"), code: "xray_up_to_date" });

    const inCode = rig({ status: "version=26.9.1\n" });
    inCode.github.release = () => new Response(releaseBody("v26.10.31"));
    await expect(inCode.service.update(ACTOR, "26.10.31")).rejects.toMatchObject({ ...failure(409, "Версия уже в коде — уедет с ближайшим выпуском"), code: "xray_in_code" });
  });

  it("выпуск старше проверенных версий — 409 older", async () => {
    const r = rig();
    r.github.release = () => new Response(releaseBody("v26.9.1"));
    await expect(r.service.update(ACTOR, "26.9.1")).rejects.toMatchObject({ ...failure(409, "Выпуск старше проверенных версий"), code: "xray_older" });
  });

  it("нет ключа — 409 no_token, GitHub не зовётся; нет выпуска — 409 no_release", async () => {
    const noToken = rig({ token: null });
    await expect(noToken.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ ...failure(409, "Нет ключа github.xray-update"), code: "xray_no_token" });
    expect(noToken.github.callsTo(DISPATCH_URL)).toHaveLength(0);

    const noRelease = rig();
    noRelease.github.release = () => new Response("", { status: 500 });
    await expect(noRelease.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ ...failure(409, "Свежий выпуск не получен — проверьте позже"), code: "xray_no_release" });
  });

  it("права проверяются в сервисе: отказ roles.require — ничего не уходит", async () => {
    const r = rig();
    r.roles.require.mockRejectedValue(Object.assign(new Error("нет права"), { status: 403 }));
    await expect(r.service.update(ACTOR, "26.11.5")).rejects.toMatchObject({ status: 403 });
    await expect(r.service.refresh(ACTOR)).rejects.toMatchObject({ status: 403 });
    expect(r.github.fetch).not.toHaveBeenCalled();
    expect(r.roles.audit).not.toHaveBeenCalled();
  });
});

describe("состояние", () => {
  const blocked = (version: string): XrayCoreBlock[] => [{ from: version, until: null, reason: "нельзя" }];
  const blockOf = async (r: Rig): Promise<UpdateBlock | null> => (await r.service.view(ACTOR)).update.blockedBy;

  it("по случаю на каждую причину закрытой кнопки", async () => {
    expect(await blockOf(rig({ token: null }))).toBe("no_token");

    const noRelease = rig();
    noRelease.github.release = () => new Response("", { status: 500 });
    expect(await blockOf(noRelease)).toBe("no_release");

    expect(await blockOf(rig({ compat: { min: "26.10.31", max: "26.10.31", blocks: blocked("26.11.5") } }))).toBe("blocked");

    const older = rig();
    older.github.release = () => new Response(releaseBody("v26.9.1"));
    expect(await blockOf(older)).toBe("older");

    expect(await blockOf(rig({ status: "version=26.11.5\n" }))).toBe("up_to_date");

    const inCode = rig({ status: "version=26.9.1\n" });
    inCode.github.release = () => new Response(releaseBody("v26.10.31"));
    expect(await blockOf(inCode)).toBe("in_code");

    const running = rig();
    running.github.runs = () => new Response(runBody({ status: "queued", conclusion: null }));
    expect(await blockOf(running)).toBe("running");

    const locked = rig();
    await locked.redis.set("xray-core:update:lock", "{}", "PX", 60_000, "NX");
    expect(await blockOf(locked)).toBe("locked");

    expect(await blockOf(rig())).toBeNull();
  });

  it("причин две — отдаётся первая по списку решений", async () => {
    // нет ключа и выпуск в блоке
    expect(await blockOf(rig({ token: null, compat: { min: "26.10.31", max: "26.10.31", blocks: blocked("26.11.5") } }))).toBe("no_token");
    // выпуск в блоке и ядро уже этой версии
    expect(await blockOf(rig({ status: "version=26.11.5\n", compat: { min: "26.10.31", max: "26.10.31", blocks: blocked("26.11.5") } }))).toBe("blocked");
    // ядро уже этой версии и запуск идёт
    const both = rig({ status: "version=26.11.5\n" });
    both.github.runs = () => new Response(runBody({ status: "in_progress", conclusion: null }));
    expect(await blockOf(both)).toBe("up_to_date");
    // запуск идёт и замок держится
    const runningLocked = rig();
    runningLocked.github.runs = () => new Response(runBody({ status: "in_progress", conclusion: null }));
    await runningLocked.redis.set("xray-core:update:lock", "{}", "PX", 60_000, "NX");
    expect(await blockOf(runningLocked)).toBe("running");
  });

  it("всё хорошо: запущенная версия, совместимость, диапазон, выпуск и последний запуск", async () => {
    const r = rig();
    r.github.runs = () => new Response(runBody());
    const view: XrayCoreView = await r.service.view(ACTOR);
    expect(r.roles.require).toHaveBeenCalledWith(ACTOR, "proxies.view");
    expect(view.running).toEqual({ state: "ok", version: "26.10.31", startedAt: "2026-11-10T09:15:02.000Z", compatibility: { kind: "tested" } });
    expect(view.tested).toEqual({ min: "26.10.31", max: "26.10.31" });
    expect(view.latest).toEqual({ version: "26.11.5", publishedAt: "2026-11-12T08:00:00.000Z", url: "https://github.com/XTLS/Xray-core/releases/tag/v26.11.5", checkedAt: new Date(START).toISOString(), compatibility: { kind: "untested" } });
    expect(view.latestError).toBeNull();
    expect(view.update).toEqual({
      configured: true,
      blockedBy: null,
      lastRun: { status: "completed", active: false, conclusion: "success", url: "https://github.com/JJSGxKD/rubezh/actions/runs/1", createdAt: "2026-11-12T10:00:00.000Z", title: "Обновление ядра Xray до 26.11.1" },
      lastRunError: null,
      lockedUntil: null,
    });
  });

  it("без параметра compat берутся константы proxy-kit", async () => {
    const service = new XrayCoreService({ roles: { require: async () => undefined, audit: async () => undefined }, secrets: noKeys, releases: rig().releases, updater: rig().updater, statusPath: statusFile(null) });
    const view = await service.view(ACTOR);
    expect(view.tested.min).toMatch(/^\d+\.\d+\.\d+$/);
    expect(view.tested.max).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("файла статуса нет — version и compatibility пустые, а не ошибка; нечитаемый — unreadable", async () => {
    const missing = (await rig({ status: null }).service.view(ACTOR)).running;
    expect(missing).toEqual({ state: "missing", version: null, startedAt: null, compatibility: null });
    const unreadable = (await rig({ status: "version=abc" }).service.view(ACTOR)).running;
    expect(unreadable).toEqual({ state: "unreadable", version: null, startedAt: null, compatibility: null });
  });

  it("без ключа последний запуск не запрашивается, configured: false", async () => {
    const r = rig({ token: null });
    const view = await r.service.view(ACTOR);
    expect(view.update).toMatchObject({ configured: false, blockedBy: "no_token", lastRun: null, lastRunError: null });
    expect(r.github.callsTo(RUNS_URL)).toHaveLength(0);
  });

  it("последний запуск кэшируется на 30 секунд; ошибка запроса — в lastRunError", async () => {
    const r = rig();
    await r.service.view(ACTOR);
    await r.service.view(ACTOR);
    expect(r.github.callsTo(RUNS_URL)).toHaveLength(1);
    expect(new Headers(r.github.callsTo(RUNS_URL)[0]?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    r.clock.advance(31_000);
    r.github.runs = () => new Response("", { status: 401 });
    const view = await r.service.view(ACTOR);
    expect(view.update.lastRun).toBeNull();
    expect(view.update.lastRunError).toBe("GitHub ответил 401");
  });

  it("lockedUntil — конец замка по PTTL", async () => {
    const r = rig();
    await r.service.view(ACTOR);
    await r.service.update(ACTOR, "26.11.5");
    r.clock.advance(240_000);
    const view = await r.service.view(ACTOR);
    expect(view.update.lockedUntil).toBe(new Date(START + 600_000).toISOString());
    expect(await r.updater.lockedUntil()).toEqual(new Date(START + 600_000));
  });

  it("«Проверить сейчас» переписывает кэш и возвращает состояние", async () => {
    const r = rig();
    await r.service.view(ACTOR);
    r.github.release = () => new Response(releaseBody("v26.11.6"));
    const view = await r.service.refresh(ACTOR);
    expect(r.roles.require).toHaveBeenLastCalledWith(ACTOR, "proxies.edit");
    expect(view.latest?.version).toBe("26.11.6");
    expect(r.roles.audit).not.toHaveBeenCalled();
  });
});

describe("панель по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  let r: Rig;
  let roles: MemoryRolesRepository;

  beforeEach(async () => {
    r = rig();
    const accounts = new MemoryAccountRepository();
    roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();

    @Module({
      controllers: [AdminXrayCoreController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "777000111" } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: r.redis as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        {
          provide: XrayCoreService,
          inject: [RolesService],
          useFactory: (service: RolesService): XrayCoreService =>
            new XrayCoreService({
              roles: service,
              secrets: withToken(TOKEN),
              releases: r.releases,
              updater: r.updater,
              statusPath: statusFile(CORE_26_10_31),
              compat: { min: "26.10.31", max: "26.10.31", blocks: [] },
              log: () => undefined,
              now: r.clock.now,
            }),
        },
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (const [token, id, role] of [
      ["own", "700000", "owner"],
      ["adm", "700001", "admin"],
      ["mod", "700002", "moderator"],
    ] as const) {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Человек ${id}`, username: null, photoUrl: null }, START);
      await roles.grant(account.accountId, role, null);
      await store.put(hashSessionToken(token), { accountId: account.accountId, platform: "telegram", platformUserId: id, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    }
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function server(): NestFastifyApplication {
    if (app === null) throw new Error("приложение не поднято");
    return app;
  }
  const call = (method: "GET" | "POST", path: string, token: string, payload?: unknown) =>
    server().inject({
      method,
      url: `/api/v1/admin/xray-core${path}`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it("GET с proxies.view (владелец, администратор) — 200 с состоянием; модератор — 403; без сессии — 401", async () => {
    const own = await call("GET", "", "own");
    expect(own.statusCode).toBe(200);
    expect((own.json() as { data: XrayCoreView }).data.running.version).toBe("26.10.31");
    expect((await call("GET", "", "adm")).statusCode).toBe(200);
    expect((await call("GET", "", "mod")).statusCode).toBe(403);
    expect((await server().inject({ method: "GET", url: "/api/v1/admin/xray-core" })).statusCode).toBe(401);
  });

  it("POST /update и /refresh без proxies.edit (администратор, модератор) — 403, GitHub не зовётся", async () => {
    for (const token of ["adm", "mod"]) {
      expect((await call("POST", "/update", token, { version: "26.11.5" })).statusCode, token).toBe(403);
      expect((await call("POST", "/refresh", token)).statusCode, token).toBe(403);
    }
    expect(r.github.fetch).not.toHaveBeenCalled();
  });

  it("POST /update с версией не того вида или лишним полем — 400 «Некорректная версия»", async () => {
    for (const body of [{ version: "26.11" }, { version: "v26.11.5" }, { version: "26.11.5", ref: "main" }, {}, { version: 26 }]) {
      const response = await call("POST", "/update", "own", body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.body).toContain("Некорректная версия");
    }
    expect(r.github.callsTo(DISPATCH_URL)).toHaveLength(0);
  });

  it("владелец: GET, затем /update запускает workflow; повтор — 409; ключа нет ни в одном ответе и аудите", async () => {
    const bodies: string[] = [];
    bodies.push((await call("GET", "", "own")).body);
    const started = await call("POST", "/update", "own", { version: "26.11.5" });
    bodies.push(started.body);
    expect(started.statusCode).toBe(200);
    expect(JSON.parse(String(r.github.callsTo(DISPATCH_URL)[0]?.init?.body))).toEqual({ ref: "dev", inputs: { version: "26.11.5" } });

    const again = await call("POST", "/update", "own", { version: "26.11.5" });
    bodies.push(again.body);
    expect(again.statusCode).toBe(409);

    const refresh = await call("POST", "/refresh", "own");
    bodies.push(refresh.body);
    expect(refresh.statusCode).toBe(200);
    expect((await call("POST", "/refresh", "own")).statusCode).toBe(429);

    bodies.push(JSON.stringify(await roles.recentAudit(100)));
    expect(bodies.join("\n")).not.toContain("github_pat_");
    const audit = (await roles.recentAudit(100)).filter((entry) => entry.action === "proxies.xray_core.update");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target: "26.11.5", after: { version: "26.11.5", running: "26.10.31" } });
  });
});

describe("ключ интеграций github.xray-update", () => {
  const secret = SECRETS.githubXrayUpdate;

  it("описание: ключ, сервис, только из панели, ссылка на выпуск токена", () => {
    expect(secret.key).toBe("github.xray-update");
    expect(secret.service).toBe("Обновление ядра Xray · GitHub");
    expect(secret.fromEnv()).toBeNull();
    expect(secret.cabinetUrl).toBe("https://github.com/settings/personal-access-tokens/new");
  });

  it("классический токен — отказ, fine-grained нужной длины — проходит, пример тоже", () => {
    expect(secretProblem(secret, `ghp_${"a".repeat(36)}`)).not.toBeNull();
    expect(secretProblem(secret, `github_pat_${"a".repeat(20)}`)).not.toBeNull();
    expect(secretProblem(secret, TOKEN)).toBeNull();
    expect(secretProblem(secret, secret.example)).toBeNull();
  });

  const check = async (responder: Responder) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const result = await secret.check?.(TOKEN, vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      return await responder(init);
    }));
    return { result, calls };
  };

  it("проверка: 200 — принят; запрос — к файлу workflow с Bearer, версией API и user-agent", async () => {
    const { result, calls } = await check(() => new Response("{}", { status: 200 }));
    expect(result?.ok).toBe(true);
    expect(calls[0]?.url).toBe(WORKFLOW_URL);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("rubezh-api");
  });

  it.each([401, 403, 404])("проверка: %i — отказ с подсказкой про право Actions: Read and write", async (status) => {
    const { result } = await check(() => new Response("{}", { status }));
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("Actions: Read and write");
    expect(result?.message).not.toContain(TOKEN);
  });
});

describe("метка исходящих github.api", () => {
  it("есть в каталоге сервисов", () => {
    expect(OUTBOUND_SERVICES).toContain("github.api");
  });
});
