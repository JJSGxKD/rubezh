import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { deviceOf, PanelLoginService, placeOf } from "../src/modules/admin/panel-login.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { PanelLoginCommand, promptText, type PanelLoginBotApi } from "../src/platforms/telegram/panel-login.command.js";
import type { TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { chatTargetOf } from "../src/platforms/ports/chat-target.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Вход в панель подтверждением в боте (docs/29-admin-panel.md §8): сессию
 * получает только открывшая запрос вкладка и только один раз; без роли и с
 * блокировкой — отказ; «Это не я» и чужая кнопка ничего не подтверждают.
 */

const OWNER_ID = "777000111";
const STRANGER_ID = "555000222";
const NOW = Date.UTC(2026, 8, 29, 12);
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, TELEGRAM_BOT_UPDATES: "polling", ...patch } as NodeJS.ProcessEnv);
}

function setup(options: { botUsername?: string | null } = {}) {
  const cfg = config();
  const accounts = new MemoryAccountRepository();
  const roles = new RolesService(cfg, new MemoryRolesRepository(), accounts);
  const sessionStore = new MemoryAdminSessionStore();
  const sessions = new AdminSessionService(cfg, accounts, sessionStore, roles);
  const store = new MemoryPanelLoginStore();
  const username = options.botUsername === undefined ? "rubezh_bot" : options.botUsername;
  const links = new AppLinks([new TelegramAppLinks({ miniAppLink: username === null ? null : `https://t.me/${username}?startapp`, username })]);
  const logins = new PanelLoginService(store, accounts, roles, sessions, links);
  return { cfg, accounts, store, sessionStore, logins };
}

const owner = { platform: "telegram" as const, platformUserId: OWNER_ID, displayName: "Владелец", username: "owner" };
const stranger = { platform: "telegram" as const, platformUserId: STRANGER_ID, displayName: "Гость", username: null };

describe("запрос входа", () => {
  it("ссылка на бота с запросом, код из четырёх цифр, секрет — только вкладке", async () => {
    const { logins, store } = setup();
    const opened = await logins.open({ userAgent: CHROME_WINDOWS, ip: "95.24.10.7" }, NOW);
    expect(opened.link).toBe(`https://t.me/rubezh_bot?start=panel-${opened.requestId}`);
    expect(opened.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(opened.code).toMatch(/^\d{4}$/);
    expect(opened.expiresAtMs).toBe(NOW + 300_000);
    // В хранилище — хэш секрета, а не он сам.
    expect(store.requests.get(opened.requestId)?.secretHash).not.toContain(opened.secret);
    expect(await logins.prompt(opened.requestId)).toEqual({ code: opened.code, device: "Chrome · Windows", place: "95.24.*.*", expiresAtMs: NOW + 300_000 });
  });

  it("бот ещё не представился — запрос не открыть", async () => {
    await expect(setup({ botUsername: null }).logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW)).rejects.toMatchObject({ code: "store_unavailable" });
  });

  it("неизвестный и кривой запрос — истёк", async () => {
    const { logins } = setup();
    expect(await logins.prompt("нет-такого")).toBeNull();
    expect(await logins.confirm("A".repeat(22), owner, NOW)).toBe("expired");
    expect(await logins.poll("A".repeat(22), "секрет", NOW)).toEqual({ status: "expired" });
  });
});

describe("подтверждение и сессия", () => {
  it("владелец подтверждает — вкладка забирает сессию один раз", async () => {
    const { logins, sessionStore } = setup();
    const opened = await logins.open({ userAgent: CHROME_WINDOWS, ip: "95.24.10.7" }, NOW);
    expect(await logins.poll(opened.requestId, opened.secret, NOW)).toEqual({ status: "pending" });

    expect(await logins.confirm(opened.requestId, owner, NOW)).toBe("confirmed");
    // Подтверждённый запрос второй раз не подтверждается и в боте уже не показывается.
    expect(await logins.confirm(opened.requestId, owner, NOW)).toBe("expired");
    expect(await logins.prompt(opened.requestId)).toBeNull();

    const polled = await logins.poll(opened.requestId, opened.secret, NOW);
    expect(polled).toMatchObject({ status: "confirmed", login: { roles: ["owner"] } });
    expect(sessionStore.sessions.size).toBe(1);
    expect(await logins.poll(opened.requestId, opened.secret, NOW)).toEqual({ status: "expired" });
    expect(sessionStore.sessions.size).toBe(1);
  });

  it("чужой секрет неотличим от истёкшего и не забирает подтверждённый вход", async () => {
    const { logins } = setup();
    const opened = await logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW);
    await logins.confirm(opened.requestId, owner, NOW);
    expect(await logins.poll(opened.requestId, "подсмотренная-ссылка", NOW)).toEqual({ status: "expired" });
    expect(await logins.poll(opened.requestId, opened.secret, NOW)).toMatchObject({ status: "confirmed" });
  });

  it("без роли — отказ, и вкладка узнаёт почему", async () => {
    const { logins, sessionStore } = setup();
    // Владелец уже есть — аварийный список больше никого не пускает.
    await logins.confirm((await logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW)).requestId, owner, NOW);
    const opened = await logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW);
    expect(await logins.confirm(opened.requestId, stranger, NOW)).toBe("no_role");
    expect(await logins.poll(opened.requestId, opened.secret, NOW)).toEqual({ status: "declined", reason: "no_role" });
    expect(sessionStore.sessions.size).toBe(0);
  });

  it("заблокированный не входит", async () => {
    const { logins, accounts } = setup();
    const account = await accounts.upsert({ ...owner, photoUrl: null }, NOW);
    await accounts.setBan(account.accountId, { at: new Date(NOW), reason: "проверка" });
    const opened = await logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW);
    expect(await logins.confirm(opened.requestId, owner, NOW)).toBe("banned");
    expect(await logins.poll(opened.requestId, opened.secret, NOW)).toEqual({ status: "declined", reason: "banned" });
  });

  it("«Это не я» закрывает запрос: подтвердить его потом нельзя", async () => {
    const { logins } = setup();
    const opened = await logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW);
    expect(await logins.decline(opened.requestId, owner)).toBe(true);
    expect(await logins.confirm(opened.requestId, owner, NOW)).toBe("expired");
    expect(await logins.poll(opened.requestId, opened.secret, NOW)).toEqual({ status: "declined", reason: "declined" });
  });

  it("выключенная панель — без входа — запрос не открывается", async () => {
    const cfg = config({ JWT_ACCESS_SECRET: "" });
    const accounts = new MemoryAccountRepository();
    const roles = new RolesService(cfg, new MemoryRolesRepository(), accounts);
    const logins = new PanelLoginService(new MemoryPanelLoginStore(), accounts, roles, new AdminSessionService(cfg, accounts, new MemoryAdminSessionStore(), roles), new AppLinks([]));
    await expect(logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW)).rejects.toMatchObject({ code: "endpoint_disabled" });
  });
});

describe("что видно в боте", () => {
  it("браузер и система — по заголовку, адрес — до сети", () => {
    expect(deviceOf(CHROME_WINDOWS)).toBe("Chrome · Windows");
    expect(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe("Safari · macOS");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 YaBrowser/25.8 Safari/537.36")).toBe("Яндекс Браузер · Windows");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36")).toBe("Chrome · Android");
    expect(deviceOf(null)).toBe("неизвестный браузер");
    expect(placeOf("95.24.10.7")).toBe("95.24.*.*");
    expect(placeOf("::ffff:10.0.0.1")).toBe("10.0.*.*");
    expect(placeOf("2a02:6b8:0:1::1")).toBe("2a02:6b8:…");
    expect(placeOf("unknown")).toBe("неизвестный адрес");
  });

  it("текст просит сверить код с экраном", () => {
    const text = promptText({ code: "4821", device: "Chrome · Windows", place: "95.24.*.*", expiresAtMs: NOW });
    expect(text).toContain("Код: 4821");
    expect(text).toContain("Это не я");
  });
});

describe("бот", () => {
  function bot() {
    const env = setup();
    const sent: { chatId: string; text: string; buttons: string[] }[] = [];
    const edited: string[] = [];
    const answered: string[] = [];
    const api: PanelLoginBotApi = {
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
    const command = new PanelLoginCommand(env.cfg, router, api, env.logins);
    command.onModuleInit();
    return { ...env, router, sent, edited, answered };
  }

  const start = (requestId: string, chat: { id: number; type: string }, fromId: number): TelegramUpdate => ({
    update_id: 1,
    message: { message_id: 1, date: 1, text: `/start panel-${requestId}`, chat, from: { id: fromId, is_bot: false, first_name: "Владелец" } },
  });
  const press = (data: string, chatId: number, fromId: number): TelegramUpdate => ({
    update_id: 2,
    callback_query: { id: `cb-${data}`, from: { id: fromId, is_bot: false, first_name: "Владелец" }, data, message: { message_id: 7, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" } } },
  });

  it("личка: запрос с кодом и двумя кнопками, «Войти» подтверждает", async () => {
    const env = bot();
    const opened = await env.logins.open({ userAgent: CHROME_WINDOWS, ip: "95.24.10.7" }, NOW);
    await env.router.dispatch(start(opened.requestId, { id: Number(OWNER_ID), type: "private" }, Number(OWNER_ID)));
    expect(env.sent[0]?.text).toContain(`Код: ${opened.code}`);
    expect(env.sent[0]?.buttons).toEqual([`panel:ok:${opened.requestId}`, `panel:no:${opened.requestId}`]);

    await env.router.dispatch(press(`panel:ok:${opened.requestId}`, Number(OWNER_ID), Number(OWNER_ID)));
    expect(env.edited).toEqual([expect.stringContaining("Вход подтверждён")]);
    expect(await env.logins.poll(opened.requestId, opened.secret, NOW)).toMatchObject({ status: "confirmed" });
  });

  it("в группе не подтверждает, а просит личку; чужая кнопка ничего не делает", async () => {
    const env = bot();
    const opened = await env.logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW);
    await env.router.dispatch(start(opened.requestId, { id: -100500, type: "supergroup" }, Number(OWNER_ID)));
    expect(env.sent[0]?.text).toContain("в личном чате");
    // Кнопка нажата в группе или из пересланного сообщения — чат не совпадает с нажавшим.
    await env.router.dispatch(press(`panel:ok:${opened.requestId}`, -100500, Number(OWNER_ID)));
    expect(env.answered).toEqual([`cb-panel:ok:${opened.requestId}`]);
    expect(await env.logins.prompt(opened.requestId)).not.toBeNull();
  });

  it("«Это не я» отклоняет, истёкший запрос называется истёкшим", async () => {
    const env = bot();
    const opened = await env.logins.open({ userAgent: null, ip: "1.2.3.4" }, NOW);
    await env.router.dispatch(press(`panel:no:${opened.requestId}`, Number(OWNER_ID), Number(OWNER_ID)));
    expect(env.edited[0]).toContain("Вход отклонён");
    await env.router.dispatch(start(opened.requestId, { id: Number(OWNER_ID), type: "private" }, Number(OWNER_ID)));
    expect(env.sent[0]?.text).toContain("истёк");
  });
});
