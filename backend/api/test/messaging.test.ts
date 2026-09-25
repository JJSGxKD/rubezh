import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import type { MessagingRepository, MessagingState } from "../src/modules/messaging/messaging.repository.js";
import { MessagingService } from "../src/modules/messaging/messaging.service.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { updateSchema } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramMessagingHandler } from "../src/platforms/telegram/telegram-messaging.handler.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";

// Можно ли писать игроку (docs/35-stage4-plan.md, §3.10): состояние меняют
// вход в канал и обновления площадки, а не слова клиента.

const NOW = Date.parse("2026-09-25T12:00:00Z");

function login(patch: Partial<LoginEvent>): LoginEvent {
  return {
    accountId: "a-1",
    platform: "telegram",
    place: "miniapp",
    startParam: { kind: "organic", raw: null, ref: null },
    created: false,
    at: new Date(NOW),
    ip: null,
    userAgent: null,
    client: null,
    reason: "launch",
    ...patch,
  };
}

class MemoryMessaging implements MessagingRepository {
  readonly states = new Map<string, MessagingState>();
  async set(accountId: string, state: MessagingState): Promise<void> {
    const current = this.states.get(accountId);
    if (current === undefined || current.changedAt <= state.changedAt) this.states.set(accountId, state);
  }
  async get(accountId: string): Promise<MessagingState | null> {
    return this.states.get(accountId) ?? null;
  }
}

describe("можно ли писать игроку", () => {
  async function world() {
    const accounts = new MemoryAccountRepository();
    const account = await accounts.upsert({ platform: "telegram", platformUserId: "555", displayName: "Анна", username: null }, NOW);
    const states = new MemoryMessaging();
    const auth = new AuthHooks();
    const messaging = new MessagingService(states, accounts, auth);
    messaging.onModuleInit();
    const router = new BotRouter();
    new TelegramMessagingHandler(loadAppConfig({ ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling" } as NodeJS.ProcessEnv), router, messaging).onModuleInit();
    return { account, states, auth, router };
  }

  const member = (status: string, date: number, chat = "private") =>
    updateSchema.parse({
      update_id: date,
      my_chat_member: { chat: { id: 555, type: chat }, from: { id: 555, is_bot: false }, date, new_chat_member: { status } },
    });

  it("вошёл в канал сам — можно", async () => {
    const { account, states, auth } = await world();
    await auth.emit(login({ accountId: account.accountId, place: "channel" }));
    expect(states.states.get(account.accountId)).toMatchObject({ canMessage: true, reason: "entered" });
  });

  it("заблокировал бота — нельзя, разблокировал — снова можно; в группе — не про игрока", async () => {
    const { account, states, router } = await world();
    await router.dispatch(member("kicked", 100));
    expect(states.states.get(account.accountId)).toMatchObject({ canMessage: false, reason: "blocked" });
    await router.dispatch(member("member", 200));
    expect(states.states.get(account.accountId)).toMatchObject({ canMessage: true, reason: "unblocked" });
    await router.dispatch(member("kicked", 300, "supergroup"));
    expect(states.states.get(account.accountId)?.canMessage).toBe(true);
  });

  it("опоздавшее старое событие не перебивает новое", async () => {
    const { account, states, router } = await world();
    await router.dispatch(member("kicked", 300));
    await router.dispatch(member("member", 200));
    expect(states.states.get(account.accountId)?.reason).toBe("blocked");
  });

  it("разрешение из приложения — служебное сообщение Telegram, а не слова клиента", async () => {
    const { account, states, router } = await world();
    await router.dispatch(
      updateSchema.parse({ update_id: 1, message: { message_id: 1, date: 400, chat: { id: 555, type: "private" }, from: { id: 555, is_bot: false }, write_access_allowed: {} } }),
    );
    expect(states.states.get(account.accountId)).toMatchObject({ canMessage: true, reason: "write_access" });
  });

  it("игрока без аккаунта не заводит: заблокировать бота можно и не заходя в игру", async () => {
    const { states, router } = await world();
    await router.dispatch(
      updateSchema.parse({ update_id: 2, my_chat_member: { chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false }, date: 1, new_chat_member: { status: "kicked" } } }),
    );
    expect(states.states.size).toBe(0);
  });
});
