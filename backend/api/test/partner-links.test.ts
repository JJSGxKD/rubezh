import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { SessionRecorder, PartnerBindFailed, sessionOf } from "../src/modules/attribution/session-recorder.js";
import type { SessionDedupe } from "../src/modules/attribution/session-dedupe.js";
import type { AcquisitionView, SessionRecord, SessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { PARTNER_RULES, PARTNER_STATUSES, type PartnerStatus } from "../src/modules/partners/partner-rules.js";
import { linkBindingDecision, type PartnerLinkBinder } from "../src/modules/partners/partner-links.js";
import type { PartnerLinksSource, PartnerLinkStats } from "../src/modules/partners/partner-links.repository.js";
import { PartnersService } from "../src/modules/partners/partners.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPartnersRepository } from "./helpers/memory-partners.js";
import { MemoryPromoCodesRepository } from "./helpers/memory-promo-codes.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Ссылки партнёра (docs/23-referral-and-partner-program.md §5, T-0067): решение
 * о привязке по касанию принимается без базы, привязку зовёт запись сессии
 * только для кликов и прямых ссылок, а её сбой сессию не откатывает. Карточка
 * партнёра получает его ссылки под правом на партнёров.
 */

const NOW = Date.UTC(2026, 9, 21, 10, 0, 0);

describe("linkBindingDecision: привязывать ли по касанию", () => {
  const fresh = { partnerStatus: "active" as PartnerStatus | null, accountAgeDays: 1, slot: "free" as const };

  it("партнёра нет — no_partner", () => {
    expect(linkBindingDecision({ ...fresh, partnerStatus: null })).toBe("no_partner");
  });

  it("не активный партнёр — inactive, при любом статусе кроме active", () => {
    for (const status of PARTNER_STATUSES) {
      expect(linkBindingDecision({ ...fresh, partnerStatus: status }), status).toBe(status === "active" ? "bind" : "inactive");
    }
  });

  it("аккаунт 8 суток при окне 7 — too_old; ровно в окне и моложе — привязка", () => {
    expect(PARTNER_RULES.bindWindowDays).toBe(7);
    expect(linkBindingDecision({ ...fresh, accountAgeDays: 8 })).toBe("too_old");
    expect(linkBindingDecision({ ...fresh, accountAgeDays: 7.001 })).toBe("too_old");
    expect(linkBindingDecision({ ...fresh, accountAgeDays: 7 })).toBe("bind");
    expect(linkBindingDecision({ ...fresh, accountAgeDays: 0 })).toBe("bind");
    // Часы входа и аккаунта могут разойтись: сессия «раньше» аккаунта новичка не старит.
    expect(linkBindingDecision({ ...fresh, accountAgeDays: -0.01 })).toBe("bind");
  });

  it("слот занят рефералом или партнёром — slot_taken", () => {
    expect(linkBindingDecision({ ...fresh, slot: "referral" })).toBe("slot_taken");
    expect(linkBindingDecision({ ...fresh, slot: "partner" })).toBe("slot_taken");
  });

  it("активный, 1 сутки, слот свободен — bind", () => {
    expect(linkBindingDecision(fresh)).toBe("bind");
  });

  it("порядок отказов: нет партнёра, статус, возраст, слот", () => {
    const worst = { partnerStatus: "paused" as const, accountAgeDays: 30, slot: "referral" as const };
    expect(linkBindingDecision({ ...worst, partnerStatus: null })).toBe("no_partner");
    expect(linkBindingDecision(worst)).toBe("inactive");
    expect(linkBindingDecision({ ...worst, partnerStatus: "active" })).toBe("too_old");
    expect(linkBindingDecision({ ...worst, partnerStatus: "active", accountAgeDays: 1 })).toBe("slot_taken");
  });
});

class MemorySessions implements SessionsRepository {
  readonly recorded: SessionRecord[] = [];
  failing = false;
  async record(session: SessionRecord): Promise<"recorded" | "duplicate"> {
    if (this.failing) throw new Error("база недоступна");
    if (this.recorded.some((known) => known.sessionId === session.sessionId)) return "duplicate";
    this.recorded.push(session);
    return "recorded";
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

const everyLaunchIsNew: SessionDedupe = { claim: async () => true };

function login(startParam: string | null, patch: Partial<LoginEvent> = {}): LoginEvent {
  return {
    accountId: randomUUID(),
    platform: "telegram",
    place: "miniapp",
    startParam: parseStartParam(startParam),
    created: true,
    at: new Date(NOW),
    ip: "203.0.113.57",
    userAgent: "Mozilla/5.0 (Linux; Android 14) Telegram-Android/11.2",
    client: { platform: "android", version: "8.0" },
    reason: "launch",
    ...patch,
  };
}

type BindCall = Parameters<PartnerLinkBinder["bindFromTouch"]>[0];

function setupRecorder() {
  const sessions = new MemorySessions();
  const calls: BindCall[] = [];
  /** на момент привязки сессия уже в базе: привязка идёт после записи, а не вместо неё */
  const recordedWhenBound: number[] = [];
  const bindFromTouch = vi.fn(async (call: BindCall) => {
    calls.push(call);
    recordedWhenBound.push(sessions.recorded.length);
    return "bind" as const;
  });
  const binder = { bindFromTouch } as unknown as PartnerLinkBinder;
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
  // Очередь не поднята — как при недоступном Redis: сессия пишется сразу.
  const recorder = new SessionRecorder(config, new AuthHooks(), sessions, everyLaunchIsNew, binder);
  return { recorder, sessions, binder, bindFromTouch, calls, recordedWhenBound };
}

describe("запись сессии зовёт привязку партнёру", () => {
  afterEach(() => vi.restoreAllMocks());

  it("клик и прямая ссылка — после записи сессии, с кодом клика или ссылки и временем запуска", async () => {
    const { recorder, sessions, calls, recordedWhenBound } = setupRecorder();
    const byClick = login("c-Ab12Cd34");
    const byLink = login("l-Zz99Yy88Xx", { at: new Date(NOW + 60_000) });
    await recorder.record(byClick);
    await recorder.record(byLink);

    expect(sessions.recorded).toHaveLength(2);
    expect(calls).toEqual([
      { accountId: byClick.accountId, startKind: "click", startRef: "Ab12Cd34", at: new Date(NOW) },
      { accountId: byLink.accountId, startKind: "link", startRef: "Zz99Yy88Xx", at: new Date(NOW + 60_000) },
    ]);
    expect(recordedWhenBound).toEqual([1, 2]);
  });

  it("запуск без ссылки, приглашение, дружба, уведомление и мусор — привязку не зовут", async () => {
    const { recorder, sessions, bindFromTouch } = setupRecorder();
    for (const param of [null, "invite", "f-Ab12Cd34Ef", "n-daily_ready", "_tgr_partner1", "что-то-ещё"]) {
      await recorder.record(login(param));
    }
    expect(sessions.recorded).toHaveLength(6);
    expect(bindFromTouch).not.toHaveBeenCalled();
  });

  it("сессия не записалась — привязки нет: привязывать нечего", async () => {
    const { recorder, sessions, bindFromTouch } = setupRecorder();
    sessions.failing = true;
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await recorder.record(login("c-Ab12Cd34"));
    expect(bindFromTouch).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("привязка упала на прямом пути: сессия записана, вход не падает, в лог — warn с аккаунтом и причиной", async () => {
    const { recorder, sessions, bindFromTouch } = setupRecorder();
    bindFromTouch.mockRejectedValueOnce(new Error("блокировка не взялась"));
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const event = login("c-Ab12Cd34");

    await expect(recorder.record(event)).resolves.toBeUndefined();

    expect(sessions.recorded).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({ module: "attribution", event: "partner_bind_failed", accountId: event.accountId, reason: "блокировка не взялась" });
  });

  it("задание очереди: привязка упала — задание падает ради повтора, сессия записана один раз; повтор доводит привязку", async () => {
    const { recorder, sessions, bindFromTouch } = setupRecorder();
    const session = sessionOf(login("l-Zz99Yy88Xx"));
    bindFromTouch.mockRejectedValueOnce(new Error("база недоступна"));

    await expect(recorder.process({ data: { session } })).rejects.toBeInstanceOf(PartnerBindFailed);
    expect(sessions.recorded).toHaveLength(1);

    // Повтор очереди: сессия уже есть (duplicate), привязка пробуется заново.
    await expect(recorder.process({ data: { session } })).resolves.toBeUndefined();
    expect(sessions.recorded).toHaveLength(1);
    expect(bindFromTouch).toHaveBeenCalledTimes(2);
  });

  it("задание очереди не про ссылку — только запись сессии", async () => {
    const { recorder, sessions, bindFromTouch } = setupRecorder();
    await recorder.process({ data: { session: sessionOf(login(null)) } });
    expect(sessions.recorded).toHaveLength(1);
    expect(bindFromTouch).not.toHaveBeenCalled();
  });

  it("сбой задания: упавшая привязка называется своим именем и несёт аккаунт, прочие — записью сессии", () => {
    const { recorder } = setupRecorder();
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const session = sessionOf(login("c-Ab12Cd34"));

    recorder.logJobFailure(session, 2, new PartnerBindFailed("нет связи"));
    recorder.logJobFailure(session, 3, new Error("нет связи"));

    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({ event: "partner_bind_failed", accountId: session.accountId, attempts: 2, reason: "нет связи" });
    expect(JSON.parse(String(spy.mock.calls[1]?.[0]))).toMatchObject({ event: "session_write_failed", sessionId: session.sessionId, attempts: 3 });
  });
});

describe("карточка партнёра: ссылки", () => {
  const OWNER_ID = "777000444";

  function setup(source?: PartnerLinksSource) {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const repository = new MemoryPartnersRepository(new MemoryPromoCodesRepository());
    const rolesService = new RolesService(config, roles, accounts);
    const service = source === undefined ? new PartnersService(repository, rolesService) : new PartnersService(repository, rolesService, source);
    return { accounts, roles, repository, service };
  }

  async function person(ctx: ReturnType<typeof setup>, id: string, role?: "marketer" | "finance" | "moderator"): Promise<AccountRef> {
    const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
    if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: "telegram", platformUserId: id };
  }

  async function partnerIn(ctx: ReturnType<typeof setup>): Promise<string> {
    const partnerId = randomUUID();
    const at = new Date(NOW);
    await ctx.repository.create({ partnerId, name: "Канал", contact: null, note: null, createdBy: randomUUID(), createdAt: at, updatedAt: at });
    return partnerId;
  }

  const LINK: PartnerLinkStats = {
    code: "Ab12Cd34Ef",
    campaign: "channel-post",
    source: "tg",
    target: "app",
    network: null,
    createdAt: new Date(NOW),
    clicks: 40,
    clicks30d: 12,
    launches: 10,
    directLaunches: 3,
    bound: 6,
  };

  it("карточка отдаёт ссылки партнёра и число игроков, привязанных по ссылкам, — под правом на партнёров", async () => {
    const asked: string[] = [];
    const source: PartnerLinksSource = {
      forPartner: async (partnerId) => {
        asked.push(partnerId);
        return { links: [LINK], bound: 6 };
      },
    };
    const ctx = setup(source);
    const partnerId = await partnerIn(ctx);
    const marketer = await person(ctx, "100", "marketer");

    const detail = await ctx.service.detail(marketer, partnerId, new Date(NOW));

    expect(detail.links).toEqual([LINK]);
    expect(detail.linkBound).toBe(6);
    expect(asked).toEqual([partnerId]);
  });

  it("право links.manage карточке не нужно: бухгалтерии партнёры видны, а ссылки — часть карточки", async () => {
    const ctx = setup({ forPartner: async () => ({ links: [LINK], bound: 1 }) });
    const partnerId = await partnerIn(ctx);
    const finance = await person(ctx, "101", "finance");
    expect((await ctx.service.detail(finance, partnerId, new Date(NOW))).links).toHaveLength(1);
  });

  it("без права на партнёров ссылок не показывают: источник не опрашивается", async () => {
    let asked = 0;
    const ctx = setup({
      forPartner: async () => {
        asked += 1;
        return { links: [], bound: 0 };
      },
    });
    const partnerId = await partnerIn(ctx);
    const moderator = await person(ctx, "102", "moderator");
    await expect(ctx.service.detail(moderator, partnerId, new Date(NOW))).rejects.toBeInstanceOf(DomainError);
    expect(asked).toBe(0);
  });

  it("партнёра нет — 404, ссылки не запрашиваются", async () => {
    let asked = 0;
    const ctx = setup({
      forPartner: async () => {
        asked += 1;
        return { links: [], bound: 0 };
      },
    });
    const marketer = await person(ctx, "103", "marketer");
    await expect(ctx.service.detail(marketer, randomUUID(), new Date(NOW))).rejects.toMatchObject({ code: "partner_not_found", status: 404 });
    expect(asked).toBe(0);
  });

  it("модуль без источника ссылок: пустой список и ноль привязанных, а не падение", async () => {
    const ctx = setup();
    const partnerId = await partnerIn(ctx);
    const marketer = await person(ctx, "104", "marketer");
    const detail = await ctx.service.detail(marketer, partnerId, new Date(NOW));
    expect(detail.links).toEqual([]);
    expect(detail.linkBound).toBe(0);
  });
});
