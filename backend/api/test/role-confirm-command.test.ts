import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig } from "../src/config/app-config.js";
import { RoleConfirmations } from "../src/modules/admin/role-confirmations.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { chatTargetOf } from "../src/platforms/ports/chat-target.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { RoleConfirmCommand, type RoleConfirmBotApi } from "../src/platforms/telegram/role-confirm.command.js";
import type { TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { ROLE_CONFIRM_START } from "../src/platforms/telegram/welcome.command.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Подтверждение выдачи роли в боте (docs/29-admin-panel.md §3.4): только в
 * личном чате и только тем, кто открыл запрос; чужая кнопка ничего не делает,
 * а `/start role-…` не считается приходом игрока.
 */

const OWNER_ID = "777000111";
const TARGET_ID = "600002";

/** Хранилище запросов, которое видит Redis: SET со сроком и GETDEL. */
class FakeRedis {
  readonly values = new Map<string, string>();
  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

async function bot() {
  const cfg = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, TELEGRAM_BOT_UPDATES: "polling" } as NodeJS.ProcessEnv);
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(cfg, rolesRepository, accounts);
  const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
  const confirmations = new RoleConfirmations(new FakeRedis() as unknown as Redis, accounts, roles, links);
  const owner = await accounts.upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null, photoUrl: null }, Date.now());
  await rolesRepository.grant(owner.accountId, "owner", null);
  const target = await accounts.upsert({ platform: "telegram", platformUserId: TARGET_ID, displayName: "Юра", username: null, photoUrl: null }, Date.now());
  const opened = await confirmations.open({ accountId: owner.accountId, platform: "telegram", platformUserId: OWNER_ID }, target.accountId, "admin");
  const requestId = opened.link.slice(opened.link.indexOf("role-") + "role-".length);

  const sent: { chatId: string; text: string; buttons: string[] }[] = [];
  const edited: string[] = [];
  const answered: string[] = [];
  const api: RoleConfirmBotApi = {
    async sendMessage(chat, text, _signal, options) {
      sent.push({ chatId: chatTargetOf(chat).chatId, text, buttons: (options?.keyboard ?? []).flat().map((button) => ("callback_data" in button ? button.callback_data : button.text)) });
      return sent.length;
    },
    async editMessageText(_chat, _id, text) {
      edited.push(text);
    },
    async answerCallbackQuery(id) {
      answered.push(id);
    },
  };
  const router = new BotRouter();
  new RoleConfirmCommand(cfg, router, api, confirmations).onModuleInit();
  return { router, sent, edited, answered, requestId, roles, target, confirmations };
}

const start = (requestId: string, chat: { id: number; type: string }, fromId: number): TelegramUpdate => ({
  update_id: 1,
  message: { message_id: 1, date: 1, text: `/start role-${requestId}`, chat, from: { id: fromId, is_bot: false, first_name: "Владелец" } },
});
const press = (data: string, chatId: number, fromId: number): TelegramUpdate => ({
  update_id: 2,
  callback_query: { id: `cb-${data}`, from: { id: fromId, is_bot: false, first_name: "Владелец" }, data, message: { message_id: 7, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" } } },
});

describe("бот: выдача роли", () => {
  it("личка: кому и какую роль, две кнопки; «Выдать» подтверждает и заменяет текст", async () => {
    const env = await bot();
    await env.router.dispatch(start(env.requestId, { id: Number(OWNER_ID), type: "private" }, Number(OWNER_ID)));
    expect(env.sent[0]?.text).toContain("Выдать роль «Администратор» аккаунту Юра (Telegram ID 600002)?");
    expect(env.sent[0]?.text).toContain("выйдите из панели везде");
    expect(env.sent[0]?.buttons).toEqual([`role:ok:${env.requestId}`, `role:no:${env.requestId}`]);

    await env.router.dispatch(press(`role:ok:${env.requestId}`, Number(OWNER_ID), Number(OWNER_ID)));
    expect(env.edited).toEqual(["✅ Роль выдана. Права действуют сразу."]);
    expect(await env.roles.rolesFor({ accountId: env.target.accountId, platform: "telegram", platformUserId: TARGET_ID })).toEqual(["admin"]);
  });

  it("в группе — отказ без данных запроса", async () => {
    const env = await bot();
    await env.router.dispatch(start(env.requestId, { id: -100500, type: "supergroup" }, Number(OWNER_ID)));
    expect(env.sent).toEqual([{ chatId: "-100500", text: "Выдачу роли подтверждают в личном чате с ботом.", buttons: [] }]);
  });

  it("нажатие из чужого чата — подтверждение не вызвано, запрос цел", async () => {
    const env = await bot();
    await env.router.dispatch(press(`role:ok:${env.requestId}`, -100500, Number(OWNER_ID)));
    expect(env.answered).toEqual([`cb-role:ok:${env.requestId}`]);
    expect(env.edited).toEqual([]);
    expect(await env.confirmations.prompt(env.requestId, OWNER_ID)).toMatchObject({ targetName: "Юра" });
  });

  it("чужой человек: запрос не показывается и не сгорает", async () => {
    const env = await bot();
    await env.router.dispatch(start(env.requestId, { id: 555000222, type: "private" }, 555000222));
    expect(env.sent[0]?.text).toBe("Этот запрос открыт другим человеком — подтвердить его может только он.");
    await env.router.dispatch(press(`role:ok:${env.requestId}`, 555000222, 555000222));
    expect(env.edited).toEqual(["Этот запрос открыт другим человеком — подтвердить его может только он."]);
    expect(await env.confirmations.prompt(env.requestId, OWNER_ID)).toMatchObject({ targetName: "Юра" });
  });

  it("«Отмена» отменяет, истёкший запрос называется истёкшим", async () => {
    const env = await bot();
    await env.router.dispatch(press(`role:no:${env.requestId}`, Number(OWNER_ID), Number(OWNER_ID)));
    expect(env.edited).toEqual(["Выдача отменена."]);
    await env.router.dispatch(start(env.requestId, { id: Number(OWNER_ID), type: "private" }, Number(OWNER_ID)));
    expect(env.sent[0]?.text).toBe("Запрос на выдачу роли истёк или уже решён. Откройте выдачу в панели заново.");
  });
});

describe("приветствие не принимает подтверждение роли за приход игрока", () => {
  it("`/start role-…` совпадает, голый `/start` — нет", () => {
    expect(ROLE_CONFIRM_START.test("/start role-abc")).toBe(true);
    expect(ROLE_CONFIRM_START.test("/start@rubezh_bot role-abc")).toBe(true);
    expect(ROLE_CONFIRM_START.test("/start")).toBe(false);
    expect(ROLE_CONFIRM_START.test("/start panel-abc")).toBe(false);
  });
});
