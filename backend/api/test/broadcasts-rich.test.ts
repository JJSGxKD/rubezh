import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { BotMessageEvents } from "../src/modules/bot-messages/bot-message-events.js";
import { BotMessages } from "../src/modules/bot-messages/bot-messages.service.js";
import { parseBroadcastMarkdown } from "../src/modules/broadcasts/broadcast-rich.js";
import { BroadcastSender, messageOf } from "../src/modules/broadcasts/broadcast-sender.js";
import { BroadcastStateError } from "../src/modules/broadcasts/broadcasts-errors.js";
import type { BroadcastsQueue } from "../src/modules/broadcasts/broadcasts-queue.js";
import { BroadcastsService, type BroadcastInput } from "../src/modules/broadcasts/broadcasts.service.js";
import { segmentSchema } from "../src/modules/broadcasts/segment.js";
import type { LinksService } from "../src/modules/links/links.service.js";
import type { MessagingService } from "../src/modules/messaging/messaging.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import { plainTextOf } from "../src/platforms/ports/rich-message.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryBroadcastsRepository } from "./helpers/memory-broadcasts.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Оформленные рассылки (tasks/T-0403, Р199, docs/29-admin-panel.md §7.2):
 * проверка разметки при сохранении, запуск только после теста себе той же
 * редакции, сообщение и событие `bot_message_sent` на каждого получателя.
 * Сборка — как в `broadcasts.test.ts`, плюс сборщик сообщений с настройками
 * панели и запись событий.
 */

const OWNER_ID = "777000111";
const BUTTON_URL = "https://rubezh.example/r/Ab12Cd34Ef";

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

type SentEvent = Parameters<BotMessageEvents["sent"]>[0];

function setup() {
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config(), rolesRepository, accounts);
  const repository = new MemoryBroadcastsRepository();
  const messenger = new FakeMessenger();
  const messengers = new Messengers([messenger]);
  const kicks: string[] = [];
  const queue = { kick: async (broadcastId: string) => void kicks.push(broadcastId) } as unknown as BroadcastsQueue;
  const createdLinks: string[] = [];
  const links = {
    webAppUrl: "https://rubezh.example",
    create: async (actor: AccountRef, input: { campaign: string }) => {
      await roles.require(actor, "links.manage");
      createdLinks.push(input.campaign);
      return { code: "Ab12Cd34Ef", campaign: input.campaign, url: BUTTON_URL };
    },
  };
  const messaging = { platformChanged: async () => {} } as unknown as MessagingService;
  const panel = panelSettings({ "bot.formats.enabled": true, "bot.rich.enabled": true });
  const composer = new BotMessages(panel);
  const events: SentEvent[] = [];
  const recorder = { sent: async (event: SentEvent) => void events.push(event) } as unknown as BotMessageEvents;
  const service = new BroadcastsService(repository, roles, links as unknown as LinksService, messengers, queue, composer);
  const sender = new BroadcastSender(repository, messengers, messaging, composer, recorder);
  sender.pause = async () => {};
  return { accounts, rolesRepository, roles, repository, messenger, kicks, createdLinks, panel, composer, events, service, sender };
}

const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

const SEGMENT = segmentSchema.parse({ reached: ["app_opened"] });
const MARKDOWN = "# Новый враг\n\nВ игре появился **Страж**: [подробности](https://t.me/rubezh_news/1)\n\n- первое\n- второе\n\n| Враг | Урон |\n|---|---|\n| Страж | 12 |";

const RICH: BroadcastInput = { title: "Новости", platform: "telegram", format: "rich", text: MARKDOWN, buttonText: "Играть", segment: SEGMENT };
const PLAIN: BroadcastInput = { title: "Просто", platform: "telegram", text: "В игре новый враг — загляни", buttonText: "Играть", segment: SEGMENT };

function recipients(count: number) {
  return Array.from({ length: count }, (_, index) => ({ accountId: randomUUID(), platformUserId: String(1000 + index) }));
}

describe("проверка разметки при сохранении", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("create: ошибка разметки — ValidationError с номером строки, черновика и ссылки кампании нет", async () => {
    await expect(s.service.create(owner, { ...RICH, text: "Привет\n\n**мир" })).rejects.toMatchObject({ code: "validation_failed", message: "строка 3: незакрытый **" });
    expect(s.repository.records.size).toBe(0);
    expect(s.createdLinks).toEqual([]);
  });

  it("в сообщении — первые три ошибки через «; »", async () => {
    await expect(s.service.create(owner, { ...RICH, text: "**а\n\n**б\n\n**в\n\n**г" })).rejects.toMatchObject({
      message: "строка 1: незакрытый **; строка 3: незакрытый **; строка 5: незакрытый **",
    });
  });

  it("простая рассылка разметку не разбирает: звёздочки остаются текстом", async () => {
    const draft = await s.service.create(owner, { ...PLAIN, text: "**не закрыто и <b>теги</b> как есть" });
    expect(draft).toMatchObject({ format: "plain", testedHash: null, text: "**не закрыто и <b>теги</b> как есть" });
  });

  it("create оформленной: формат хранится, отметки теста нет, в аудит — формат", async () => {
    const draft = await s.service.create(owner, RICH);
    expect(draft).toMatchObject({ format: "rich", testedHash: null, status: "draft" });
    expect(s.rolesRepository.entries.at(-1)).toMatchObject({ action: "broadcast.create", after: { format: "rich" } });
  });

  it("update: ошибка разметки — отказ, черновик не тронут; без формата в правке формат остаётся", async () => {
    const draft = await s.service.create(owner, RICH);
    await expect(s.service.update(owner, draft.broadcastId, { title: "Новости", text: "# Ок\n\n[а](http://x.example)", buttonText: "Играть", segment: SEGMENT })).rejects.toMatchObject({
      code: "validation_failed",
      message: "строка 3: ссылка должна начинаться с https://: http://x.example",
    });
    expect((await s.repository.byId(draft.broadcastId))?.text).toBe(MARKDOWN);

    const edited = await s.service.update(owner, draft.broadcastId, { title: "Новости 2", text: "# Ок", buttonText: "Играть", segment: SEGMENT });
    expect(edited).toMatchObject({ format: "rich", text: "# Ок" });
    expect(s.rolesRepository.entries.at(-1)).toMatchObject({ action: "broadcast.update", before: { format: "rich" }, after: { format: "rich" } });
  });

  it("update: формат меняют явно; простой текст в оформленную — разбор, обратно — без разбора", async () => {
    const draft = await s.service.create(owner, { ...PLAIN, text: "**не закрыто" });
    await expect(s.service.update(owner, draft.broadcastId, { ...PLAIN, format: "rich", text: "**не закрыто" })).rejects.toMatchObject({ message: "строка 1: незакрытый **" });
    const toRich = await s.service.update(owner, draft.broadcastId, { ...PLAIN, format: "rich", text: "**закрыто**" });
    expect(toRich.format).toBe("rich");
    expect((await s.service.update(owner, draft.broadcastId, { ...PLAIN, format: "plain", text: "**не закрыто" })).format).toBe("plain");
  });
});

describe("запуск только после теста себе той же редакции", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.repository.audience = recipients(3);
  });

  const notTested = { code: "broadcast_state", message: "Оформленную рассылку запускают после теста себе этой же редакции" };

  it("без теста — BroadcastStateError, аудитория даже не считается", async () => {
    const draft = await s.service.create(owner, RICH);
    s.repository.audience = [];
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toBeInstanceOf(BroadcastStateError);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);
    expect(s.kicks).toEqual([]);
  });

  it("проверка теста идёт раньше правила двух ключей", async () => {
    const draft = await s.service.create(owner, RICH);
    s.repository.audience = recipients(1_001);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);
  });

  it("тест себе ушёл оформленным → отметка → запуск проходит; сообщение с rich, простым текстом и темой «Новости»", async () => {
    const draft = await s.service.create(owner, RICH);
    expect(await s.service.testSend(owner, draft.broadcastId)).toEqual({ status: "sent" });
    const doc = parseBroadcastMarkdown(MARKDOWN).doc;
    expect(s.messenger.sent).toEqual([{ to: OWNER_ID, message: { text: plainTextOf(doc), button: { text: "Играть", url: BUTTON_URL }, topic: "news", rich: doc } }]);
    expect((await s.service.view(owner, draft.broadcastId)).tested).toBe(true);

    expect(await s.service.start(owner, draft.broadcastId)).toEqual({ audience: 3 });
    expect(s.kicks).toEqual([draft.broadcastId]);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject({ code: "broadcast_state", message: "Рассылка уже запущена или закрыта" });
    expect(s.kicks).toHaveLength(1);
  });

  it("тест ушёл запасным текстом (fallback) — отметки нет, запуск отказывает", async () => {
    const draft = await s.service.create(owner, RICH);
    s.messenger.outcomes.set(OWNER_ID, { status: "sent", fallback: true });
    expect(await s.service.testSend(owner, draft.broadcastId)).toEqual({ status: "sent", fallback: true });
    expect((await s.service.view(owner, draft.broadcastId)).tested).toBe(false);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);
  });

  it("тест не дошёл (blocked, failed, retry) — отметки нет", async () => {
    const draft = await s.service.create(owner, RICH);
    for (const outcome of [{ status: "blocked" }, { status: "failed", reason: "400" }, { status: "retry", afterSec: 5 }] as const) {
      s.messenger.outcomes.set(OWNER_ID, outcome);
      expect(await s.service.testSend(owner, draft.broadcastId)).toEqual(outcome);
    }
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);
  });

  it("правка после теста сбрасывает допуск: и текста, и одного названия; новый тест возвращает", async () => {
    const draft = await s.service.create(owner, RICH);
    await s.service.testSend(owner, draft.broadcastId);

    await s.service.update(owner, draft.broadcastId, { title: "Другое название", text: MARKDOWN, buttonText: "Играть", segment: SEGMENT });
    expect((await s.service.view(owner, draft.broadcastId)).tested).toBe(false);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);

    await s.service.testSend(owner, draft.broadcastId);
    await s.service.update(owner, draft.broadcastId, { title: "Другое название", text: `${MARKDOWN}\n\nПравка`, buttonText: "Играть", segment: SEGMENT });
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);

    await s.service.testSend(owner, draft.broadcastId);
    expect(await s.service.start(owner, draft.broadcastId)).toEqual({ audience: 3 });
  });

  it("отметка от старой редакции не годится: тест ушёл, пока правили текст", async () => {
    const draft = await s.service.create(owner, RICH);
    await s.service.testSend(owner, draft.broadcastId);
    const tested = (await s.repository.byId(draft.broadcastId))?.testedHash ?? "";
    expect(tested).toMatch(/^[0-9a-f]{64}$/);

    await s.service.update(owner, draft.broadcastId, { title: "Новости", text: "# Другой текст", buttonText: "Играть", segment: SEGMENT });
    // Запоздавший тест записывает отпечаток прежнего текста поверх новой правки.
    expect(await s.repository.markTested(draft.broadcastId, tested)).toBe(true);
    expect((await s.service.view(owner, draft.broadcastId)).tested).toBe(false);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);
  });

  it("хранилище не запустит оформленную без отпечатка текущей редакции, даже если сервис пропустил", async () => {
    const draft = await s.service.create(owner, RICH);
    await expect(s.repository.start(draft.broadcastId, owner.accountId, new Date())).rejects.toMatchObject(notTested);
    expect((await s.repository.byId(draft.broadcastId))?.status).toBe("draft");

    // Отпечаток чужой редакции — то же самое.
    await s.repository.markTested(draft.broadcastId, "0".repeat(64));
    await expect(s.repository.start(draft.broadcastId, owner.accountId, new Date())).rejects.toMatchObject(notTested);
  });

  it("ключ bot.rich.enabled или bot.formats.enabled выключен на тесте — сообщение без rich, отметки нет", async () => {
    for (const key of ["bot.rich.enabled", "bot.formats.enabled"]) {
      const draft = await s.service.create(owner, RICH);
      s.panel.set(key, false);
      expect(await s.service.testSend(owner, draft.broadcastId)).toEqual({ status: "sent" });
      const message = s.messenger.sent.at(-1)?.message;
      expect(message?.rich).toBeUndefined();
      expect(message?.text).toBe(plainTextOf(parseBroadcastMarkdown(MARKDOWN).doc));
      await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject(notTested);
      s.panel.set(key, true);
    }
  });

  it("тест другого редактора засчитывается: маркетолог проверил, запускает владелец", async () => {
    const draft = await s.service.create(owner, RICH);
    const account = await s.accounts.upsert({ platform: "telegram", platformUserId: "600001", displayName: "Маркетолог", username: null, photoUrl: null }, Date.now());
    await s.rolesRepository.grant(account.accountId, "marketer", null);
    const marketer: AccountRef = { accountId: account.accountId, platform: "telegram", platformUserId: "600001" };

    await s.service.testSend(marketer, draft.broadcastId);
    expect(s.messenger.sent.at(-1)?.to).toBe("600001");
    expect(await s.service.start(owner, draft.broadcastId)).toEqual({ audience: 3 });
  });

  it("большая аудитория: тест нужен, и одобрение второго человека — тоже", async () => {
    const draft = await s.service.create(owner, RICH);
    await s.service.testSend(owner, draft.broadcastId);
    s.repository.audience = recipients(1_001);
    await expect(s.service.start(owner, draft.broadcastId)).rejects.toMatchObject({ code: "approval_required" });
  });

  it("простая рассылка тестом не обусловлена: запускается сразу, отметка не ставится", async () => {
    const draft = await s.service.create(owner, PLAIN);
    expect(await s.service.start(owner, draft.broadcastId)).toEqual({ audience: 3 });
    const other = await s.service.create(owner, PLAIN);
    await s.service.testSend(owner, other.broadcastId);
    expect((await s.repository.byId(other.broadcastId))?.testedHash).toBeNull();
    expect((await s.service.view(owner, other.broadcastId)).tested).toBe(false);
  });
});

describe("предпросмотр", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("документ, простой текст и ошибки; право — broadcast.edit", async () => {
    const preview = await s.service.preview(owner, "# Заголовок\n\n**жирный**");
    expect(preview).toEqual({ doc: { blocks: [{ kind: "heading", level: 1, text: "Заголовок" }, { kind: "paragraph", text: { kind: "bold", text: "жирный" } }] }, plain: "Заголовок\n\nжирный", problems: [] });

    const broken = await s.service.preview(owner, "Привет **мир");
    expect(broken.problems).toEqual(["строка 1: незакрытый **"]);
    expect(broken.plain).toBe("Привет **мир");

    const moderator = await s.accounts.upsert({ platform: "telegram", platformUserId: "600002", displayName: "Модератор", username: null, photoUrl: null }, Date.now());
    await s.rolesRepository.grant(moderator.accountId, "moderator", null);
    await expect(s.service.preview({ accountId: moderator.accountId, platform: "telegram", platformUserId: "600002" }, "текст")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("предпросмотр ничего не пишет и никому не отправляет", async () => {
    await s.service.preview(owner, MARKDOWN);
    expect(s.repository.records.size).toBe(0);
    expect(s.messenger.sent).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });
});

describe("сообщение рассылки", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("простая рассылка — как раньше, и с сборщиком тоже: ровно текст и кнопка", async () => {
    const draft = await s.service.create(owner, PLAIN);
    const expected = { text: PLAIN.text, button: { text: "Играть", url: BUTTON_URL } };
    expect(messageOf(draft)).toEqual(expected);
    expect(messageOf(draft, s.composer)).toEqual(expected);
    expect(Object.keys(messageOf(draft, s.composer)).sort()).toEqual(["button", "text"]);
  });

  it("оформленная без сборщика — как раньше: текст исходника и кнопка", async () => {
    const draft = await s.service.create(owner, RICH);
    expect(messageOf(draft)).toEqual({ text: MARKDOWN, button: { text: "Играть", url: BUTTON_URL } });
  });

  it("оформленная со сборщиком — rich, простой текст документа и тема «Новости»; без кнопки — button null", async () => {
    const draft = await s.service.create(owner, { ...RICH, buttonText: null });
    const doc = parseBroadcastMarkdown(MARKDOWN).doc;
    expect(messageOf(draft, s.composer)).toEqual({ text: plainTextOf(doc), button: null, topic: "news", rich: doc });
  });
});

describe("отправка: сообщение и событие на каждого получателя", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  async function started(input: BroadcastInput, count: number): Promise<string> {
    const draft = await s.service.create(owner, input);
    await s.service.testSend(owner, draft.broadcastId);
    s.messenger.sent.length = 0;
    s.repository.audience = recipients(count);
    await s.service.start(owner, draft.broadcastId);
    return draft.broadcastId;
  }

  async function sendAll(id: string): Promise<void> {
    while ((await s.sender.sendBatch(id)).kind === "continue");
  }

  it("каждый получает rich, простой текст документа, кнопку кампании и тему «Новости»; событие — на каждого", async () => {
    const id = await started(RICH, 5);
    await sendAll(id);
    const doc = parseBroadcastMarkdown(MARKDOWN).doc;

    expect(s.messenger.sent).toHaveLength(5);
    for (const { message } of s.messenger.sent) expect(message).toEqual({ text: plainTextOf(doc), button: { text: "Играть", url: BUTTON_URL }, topic: "news", rich: doc });
    expect(s.events).toHaveLength(5);
    for (const event of s.events) expect(event).toEqual({ kind: "news", format: "rich", outcome: "sent", topic: "news", silent: false, platform: "telegram" });
    expect((await s.repository.byId(id))?.status).toBe("done");
  });

  it("исходы: блокировка и отказ — события с их исходом; запасной текст — format text и outcome fallback", async () => {
    const id = await started(RICH, 4);
    const [blocked, failed, fallback] = s.repository.audience;
    s.messenger.outcomes.set(blocked?.platformUserId ?? "", { status: "blocked" });
    s.messenger.outcomes.set(failed?.platformUserId ?? "", { status: "failed", reason: "400" });
    s.messenger.outcomes.set(fallback?.platformUserId ?? "", { status: "sent", fallback: true });
    await sendAll(id);

    expect(s.events.map((event) => [event.format, event.outcome])).toEqual([
      ["rich", "blocked"],
      ["rich", "failed"],
      ["text", "fallback"],
      ["rich", "sent"],
    ]);
  });

  it("retry события не пишет: получатель вернётся в очередь и получит его с окончательным исходом", async () => {
    const id = await started(RICH, 3);
    const [first] = s.repository.audience;
    s.messenger.outcomes.set(first?.platformUserId ?? "", { status: "retry", afterSec: 9 });
    expect(await s.sender.sendBatch(id)).toEqual({ kind: "wait", afterSec: 9 });
    expect(s.events).toEqual([]);

    s.messenger.outcomes.clear();
    await sendAll(id);
    expect(s.events).toHaveLength(3);
  });

  it("простая рассылка: сообщение как раньше, событие news/text без темы", async () => {
    const draft = await s.service.create(owner, PLAIN);
    s.repository.audience = recipients(2);
    await s.service.start(owner, draft.broadcastId);
    await sendAll(draft.broadcastId);

    expect(s.messenger.sent.map((item) => item.message)).toEqual([
      { text: PLAIN.text, button: { text: "Играть", url: BUTTON_URL } },
      { text: PLAIN.text, button: { text: "Играть", url: BUTTON_URL } },
    ]);
    expect(s.events).toEqual([
      { kind: "news", format: "text", outcome: "sent", topic: "none", silent: false, platform: "telegram" },
      { kind: "news", format: "text", outcome: "sent", topic: "none", silent: false, platform: "telegram" },
    ]);
  });

  it("без сборщика и записи событий отправитель работает как раньше (позиционная сборка тестов)", async () => {
    const draft = await s.service.create(owner, PLAIN);
    s.repository.audience = recipients(2);
    await s.service.start(owner, draft.broadcastId);
    const bare = new BroadcastSender(s.repository, new Messengers([s.messenger]), { platformChanged: async () => {} } as unknown as MessagingService);
    bare.pause = async () => {};
    while ((await bare.sendBatch(draft.broadcastId)).kind === "continue");
    expect(s.messenger.sent).toHaveLength(2);
    expect(s.events).toEqual([]);
  });

  describe("разметка, не прошедшая проверку, до получателей не доходит", () => {
    let warn: MockInstance;
    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("если всё же дошла — простой текст без rich и одна запись broadcast_rich_invalid на рассылку", async () => {
      const id = await started(RICH, 20);
      const record = await s.repository.byId(id);
      if (record === null) throw new Error("рассылки нет");
      // Строка в базе, которой не мог создать сервис: правка в обход.
      s.repository.records.set(id, { ...record, text: "**сломано" });
      await sendAll(id);

      expect(s.messenger.sent).toHaveLength(20);
      for (const { message } of s.messenger.sent) {
        expect(message.rich).toBeUndefined();
        expect(message.text).toBe("**сломано");
      }
      const logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("broadcast_rich_invalid"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ module: "broadcasts", event: "broadcast_rich_invalid", broadcastId: id });
    });
  });
});
