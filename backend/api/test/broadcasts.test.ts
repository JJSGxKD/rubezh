import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { BROADCAST_RULES } from "../src/modules/broadcasts/broadcast-rules.js";
import { BroadcastSender, messageOf } from "../src/modules/broadcasts/broadcast-sender.js";
import { BroadcastsQueue } from "../src/modules/broadcasts/broadcasts-queue.js";
import { BroadcastsService, type BroadcastInput } from "../src/modules/broadcasts/broadcasts.service.js";
import { segmentSchema } from "../src/modules/broadcasts/segment.js";
import type { LinksService } from "../src/modules/links/links.service.js";
import type { MessagingService } from "../src/modules/messaging/messaging.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryBroadcastsRepository } from "./helpers/memory-broadcasts.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Рассылки в бота (docs/29-admin-panel.md §7): права, правило двух ключей,
 * неизменность после старта, темп и исходы доставки. SQL сегмента и захват
 * строк — в интеграционном тесте на Postgres.
 */

const OWNER_ID = "777000111";

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_PANEL_ENABLED: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
}

class FakeMessenger implements Messenger {
  readonly platform = "telegram" as const;
  readonly ratePerSec = 2;
  configured = true;
  readonly sent: { to: string; message: OutgoingMessage }[] = [];
  /** исход по получателю; по умолчанию — доставлено */
  outcomes = new Map<string, SendOutcome>();

  async send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome> {
    this.sent.push({ to: platformUserId, message });
    return this.outcomes.get(platformUserId) ?? { status: "sent" };
  }
}

function setup() {
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config(), rolesRepository, accounts);
  const repository = new MemoryBroadcastsRepository();
  const messenger = new FakeMessenger();
  const messengers = new Messengers([messenger]);
  const kicks: { broadcastId: string; delaySec: number }[] = [];
  const queue = { kick: async (broadcastId: string, delaySec = 0) => void kicks.push({ broadcastId, delaySec }) } as unknown as BroadcastsQueue;
  const links = {
    webAppUrl: "https://rubezh.example",
    create: async (actor: AccountRef, input: { campaign: string }) => {
      await roles.require(actor, "links.manage");
      return { code: "Ab12Cd34Ef", campaign: input.campaign, url: `${links.webAppUrl}/r/Ab12Cd34Ef` };
    },
  };
  const blocked: string[] = [];
  const messaging = { platformChanged: async (_platform: string, platformUserId: string) => void blocked.push(platformUserId) } as unknown as MessagingService;
  const service = new BroadcastsService(repository, roles, links as unknown as LinksService, messengers, queue);
  const sender = new BroadcastSender(repository, messengers, messaging);
  sender.pause = async () => {};
  return { accounts, rolesRepository, roles, repository, messenger, kicks, links, blocked, service, sender };
}

const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

const INPUT: BroadcastInput = {
  title: "Новый враг",
  platform: "telegram",
  text: "В игре новый враг — загляни",
  buttonText: "Играть",
  segment: segmentSchema.parse({ reached: ["app_opened"] }),
};

function recipients(count: number) {
  return Array.from({ length: count }, (_, index) => ({ accountId: randomUUID(), platformUserId: String(1000 + index) }));
}

describe("сегмент", () => {
  it("умолчания, лишние поля и противоречия", () => {
    expect(segmentSchema.parse({})).toEqual({ startKinds: [], reached: [], notReached: [], skipRecentDays: BROADCAST_RULES.skipRecentDays });
    expect(segmentSchema.safeParse({ platform: "telegram" }).success).toBe(false);
    expect(segmentSchema.safeParse({ reached: ["runs_2"], notReached: ["runs_2"] }).success).toBe(false);
    expect(segmentSchema.safeParse({ activeWithinDays: 7, inactiveForDays: 14 }).success).toBe(false);
    expect(segmentSchema.safeParse({ activeWithinDays: 30, inactiveForDays: 7 }).success).toBe(true);
    expect(segmentSchema.safeParse({ reached: ["drop table"] }).success).toBe(false);
    expect(segmentSchema.safeParse({ campaign: "Канал" }).success).toBe(false);
  });
});

describe("черновик и права", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  async function withRole(role: "admin" | "marketer" | "moderator", id: string): Promise<AccountRef> {
    const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: role, username: null, photoUrl: null }, Date.now());
    await s.rolesRepository.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: "telegram", platformUserId: id };
  }

  it("кнопка ведёт через ссылку кампании рассылки; создание — в аудит", async () => {
    const created = await s.service.create(owner, INPUT);
    expect(created).toMatchObject({ status: "draft", linkCode: "Ab12Cd34Ef", buttonUrl: "https://rubezh.example/r/Ab12Cd34Ef" });
    expect(messageOf(created)).toEqual({ text: INPUT.text, button: { text: "Играть", url: "https://rubezh.example/r/Ab12Cd34Ef" } });
    expect((await s.service.create(owner, { ...INPUT, buttonText: null })).linkCode).toBeNull();
    expect(s.rolesRepository.entries.map((entry) => entry.action)).toEqual(["broadcast.create", "broadcast.create"]);
  });

  it("без домена клиента кнопку не собрать, без бота площадки — рассылку", async () => {
    s.links.webAppUrl = "";
    await expect(s.service.create(owner, INPUT)).rejects.toMatchObject({ code: "validation_failed" });
    s.messenger.configured = false;
    await expect(s.service.create(owner, { ...INPUT, buttonText: null })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("маркетолог пишет черновик, но не запускает; модератору раздел закрыт", async () => {
    const marketer = await withRole("marketer", "600001");
    const draft = await s.service.create(marketer, INPUT);
    s.repository.audience = recipients(3);
    await expect(s.service.start(marketer, draft.broadcastId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.service.approve(marketer, draft.broadcastId)).rejects.toMatchObject({ code: "forbidden" });
    const moderator = await withRole("moderator", "600002");
    await expect(s.service.list(moderator)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("правка — только черновика и снимает одобрение; кнопку добавляют при создании", async () => {
    const draft = await s.service.create(owner, { ...INPUT, buttonText: null });
    await s.service.approve(owner, draft.broadcastId);
    const edited = await s.service.update(owner, draft.broadcastId, { title: "Ещё враг", text: "Текст", buttonText: null, segment: INPUT.segment });
    expect(edited).toMatchObject({ title: "Ещё враг", approvedBy: null });
    await expect(s.service.update(owner, draft.broadcastId, { ...INPUT, buttonText: "Играть" })).rejects.toMatchObject({ code: "validation_failed" });

    s.repository.audience = recipients(1);
    await s.service.start(owner, draft.broadcastId);
    await expect(s.service.update(owner, draft.broadcastId, { title: "Поздно", text: "Текст", buttonText: null, segment: INPUT.segment })).rejects.toMatchObject({
      code: "broadcast_state",
    });
  });

  it("тест себе — в свой чат с ботом той же площадки", async () => {
    const draft = await s.service.create(owner, INPUT);
    expect(await s.service.testSend(owner, draft.broadcastId)).toEqual({ status: "sent" });
    expect(s.messenger.sent).toEqual([{ to: OWNER_ID, message: messageOf(draft) }]);
    const vkAdmin = await s.accounts.upsert({ platform: "vk", platformUserId: "42", displayName: "VK", username: null, photoUrl: null }, Date.now());
    await s.rolesRepository.grant(vkAdmin.accountId, "admin", null);
    await expect(s.service.testSend({ accountId: vkAdmin.accountId, platform: "vk", platformUserId: "42" }, draft.broadcastId)).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(s.service.testSend(owner, randomUUID())).rejects.toMatchObject({ code: "broadcast_not_found" });
  });
});

describe("старт и правило двух ключей", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  async function admin(id: string): Promise<AccountRef> {
    const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: "Админ", username: null, photoUrl: null }, Date.now());
    await s.rolesRepository.grant(account.accountId, "admin", null);
    return { accountId: account.accountId, platform: "telegram", platformUserId: id };
  }

  it("малую аудиторию запускает один человек; второй старт и пустая аудитория — отказ", async () => {
    const draft = await s.service.create(owner, INPUT);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject({ code: "validation_failed" });

    s.repository.audience = recipients(3);
    expect(await s.service.start(owner, draft.broadcastId)).toEqual({ audience: 3 });
    expect(s.kicks).toEqual([{ broadcastId: draft.broadcastId, delaySec: 0 }]);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject({ code: "broadcast_state" });
    expect(s.rolesRepository.entries.at(-1)).toMatchObject({ action: "broadcast.start", target: draft.broadcastId, after: { audience: 3 } });
  });

  it("большую — только после одобрения другим человеком", async () => {
    const first = await admin("600010");
    const second = await admin("600011");
    const draft = await s.service.create(first, INPUT);
    s.repository.audience = recipients(BROADCAST_RULES.approvalAudience + 1);

    await expect(s.service.start(first, draft.broadcastId)).rejects.toMatchObject({ code: "approval_required" });
    await s.service.approve(first, draft.broadcastId);
    await expect(s.service.start(first, draft.broadcastId)).rejects.toMatchObject({ code: "approval_required" });

    await s.service.approve(second, draft.broadcastId);
    expect(await s.service.start(first, draft.broadcastId)).toEqual({ audience: BROADCAST_RULES.approvalAudience + 1 });
  });

  it("пауза, продолжение и отмена — по состоянию и в аудит", async () => {
    const draft = await s.service.create(owner, INPUT);
    await expect(s.service.pause(owner, draft.broadcastId)).rejects.toMatchObject({ code: "broadcast_state" });
    s.repository.audience = recipients(2);
    await s.service.start(owner, draft.broadcastId);

    expect((await s.service.pause(owner, draft.broadcastId)).status).toBe("paused");
    expect((await s.service.resume(owner, draft.broadcastId)).status).toBe("sending");
    expect(s.kicks).toHaveLength(2);
    expect((await s.service.cancel(owner, draft.broadcastId)).status).toBe("cancelled");
    await expect(s.service.resume(owner, draft.broadcastId)).rejects.toMatchObject({ code: "broadcast_state" });
    expect(s.rolesRepository.entries.map((entry) => entry.action).slice(-3)).toEqual(["broadcast.paused", "broadcast.sending", "broadcast.cancelled"]);
    expect((await s.service.view(owner, draft.broadcastId)).stats).toMatchObject({ queued: 2, sent: 0 });
  });
});

describe("пачка отправки", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  async function started(count: number): Promise<string> {
    const draft = await s.service.create(owner, INPUT);
    s.repository.audience = recipients(count);
    await s.service.start(owner, draft.broadcastId);
    return draft.broadcastId;
  }

  it("пачка — темп площадки на batchSec, текст с кнопкой; дальше — следующая, пустая очередь — конец", async () => {
    const id = await started(10);
    const perBatch = s.messenger.ratePerSec * BROADCAST_RULES.batchSec;
    expect(await s.sender.sendBatch(id)).toEqual({ kind: "continue" });
    expect(s.messenger.sent).toHaveLength(perBatch);
    expect(s.messenger.sent[0]?.message.button?.url).toBe("https://rubezh.example/r/Ab12Cd34Ef");

    while ((await s.sender.sendBatch(id)).kind === "continue");
    expect(s.messenger.sent).toHaveLength(10);
    expect((await s.repository.byId(id))?.status).toBe("done");
    expect(await s.repository.stats(id)).toMatchObject({ sent: 10, queued: 0 });
  });

  it("блокировка отмечается у игрока, отказ — в итоге с кодом", async () => {
    const id = await started(3);
    const [first, second] = s.repository.audience;
    s.messenger.outcomes.set(first?.platformUserId ?? "", { status: "blocked" });
    s.messenger.outcomes.set(second?.platformUserId ?? "", { status: "failed", reason: "400" });
    await s.sender.sendBatch(id);

    expect(s.blocked).toEqual([first?.platformUserId]);
    expect(await s.repository.stats(id)).toMatchObject({ blocked: 1, failed: 1, sent: 1 });
    expect(s.repository.row(id, second?.accountId ?? "").error).toBe("400");
  });

  it("429 обрывает пачку: остаток отпущен, пауза — сколько просили; после отсрочек — отказ", async () => {
    const id = await started(4);
    const [first] = s.repository.audience;
    s.messenger.outcomes.set(first?.platformUserId ?? "", { status: "retry", afterSec: 7 });

    expect(await s.sender.sendBatch(id)).toEqual({ kind: "wait", afterSec: 7 });
    expect(s.messenger.sent).toHaveLength(1);
    expect((await s.repository.claim(id, 10)).length).toBe(4);
    for (const recipient of s.repository.audience) await s.repository.release(id, [recipient.accountId]);

    for (let attempt = 1; attempt < BROADCAST_RULES.maxDeferrals; attempt++) await s.sender.sendBatch(id);
    expect(s.repository.row(id, first?.accountId ?? "")).toMatchObject({ status: "failed", error: "deferred" });
  });

  it("пауза и отмена видны со следующей пачки; пропал бот — рассылка на паузе", async () => {
    const id = await started(3);
    await s.service.pause(owner, id);
    expect(await s.sender.sendBatch(id)).toEqual({ kind: "stopped" });
    expect(s.messenger.sent).toHaveLength(0);

    await s.service.resume(owner, id);
    s.messenger.configured = false;
    expect(await s.sender.sendBatch(id)).toEqual({ kind: "stopped" });
    expect((await s.repository.byId(id))?.status).toBe("paused");
  });
});

describe("очередь рассылок", () => {
  it("пачка ставит следующую, пауза площадки — с задержкой, конец — ничего; без Redis отправка не идёт", async () => {
    const s = setup();
    const outcomes = [{ kind: "continue" }, { kind: "wait", afterSec: 7 }, { kind: "done" }, { kind: "stopped" }] as const;
    const sender = { sendBatch: async () => outcomes[step++] } as unknown as BroadcastSender;
    let step = 0;
    const queue = new BroadcastsQueue(config(), s.repository, sender);
    const kicks: [string, number][] = [];
    queue.kick = async (broadcastId: string, delaySec = 0) => void kicks.push([broadcastId, delaySec]);
    for (let index = 0; index < outcomes.length; index++) await queue.process({ data: { broadcastId: "b1" } });
    expect(kicks).toEqual([
      ["b1", 0],
      ["b1", 7],
    ]);

    await expect(new BroadcastsQueue(config(), s.repository, sender).kick("b1")).rejects.toMatchObject({ code: "store_unavailable" });
  });
});
