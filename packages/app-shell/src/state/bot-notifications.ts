import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Что дублировать в бота (docs/35-stage4-plan.md Р51, WP28): заявку в
 * друзья, подарок друга, сообщение команды. О выходе версии бот не пишет (T-0019). Выбор — за
 * аккаунтом, решает по нему сервер, когда пишет в бота; здесь его копия для переключателей и то,
 * что выбрано и ещё не дошло.
 *
 * Умолчания — те же, что у сервера (`backend/api/src/modules/notifications-bot/bot-notify-rules.ts`),
 * расхождение ловит `scripts/test/account-settings-keys.test.ts`. Подарок
 * выключен: каждый день от каждого друга — это уже спам.
 *
 * Модуль не в первой загрузке: его берут экран настроек и синхронизация
 * настроек аккаунта, поэтому значения читаются с устройства при создании
 * стора, а не на старте оболочки. О выборе синхронизации сообщает экран
 * настроек, а не стор: синхронизация сама читает этот стор, и обратный
 * импорт замкнул бы их друг на друга.
 */

export const BOT_NOTIFY_DEFAULTS = { friendRequest: true, friendGift: false, teamMessage: true } as const;

export type BotNotifyKey = keyof typeof BOT_NOTIFY_DEFAULTS;
export type BotNotifySettings = Record<BotNotifyKey, boolean>;

/** Ключ настройки аккаунта для каждого переключателя. */
export const BOT_NOTIFY_ACCOUNT_KEYS = {
  friendRequest: "bot.friendRequest",
  friendGift: "bot.friendGift",
  teamMessage: "bot.teamMessage",
} as const satisfies Record<BotNotifyKey, string>;

export type BotNotifyAccountKey = (typeof BOT_NOTIFY_ACCOUNT_KEYS)[BotNotifyKey];

export const BOT_NOTIFY_KEYS: readonly BotNotifyKey[] = ["friendRequest", "friendGift", "teamMessage"];

const STORAGE_KEY = "bh.bot-notifications.v1";
/**
 * Не `strict`: у выбора, сохранённого раньше, бывают поля, которых больше нет
 * (`updates`), — они отбрасываются, а остальной выбор не сбрасывается как битый.
 */
const schema = z.object({ friendRequest: z.boolean(), friendGift: z.boolean(), teamMessage: z.boolean() });
type Stored = z.infer<typeof schema>;

export interface BotNotifyStore extends BotNotifySettings {
  /** переключить и запомнить на устройстве; новое значение — для синхронизации */
  toggle(key: BotNotifyKey): boolean;
  /** выбранное на другом устройстве аккаунта (`account-settings.ts`) */
  applyAccount(values: Partial<BotNotifySettings>): void;
}

export const useBotNotifications = create<BotNotifyStore>((set, get) => ({
  ...readStored(),

  toggle(key): boolean {
    const next = !get()[key];
    set({ [key]: next } as Pick<BotNotifySettings, BotNotifyKey>);
    persist(get());
    track("settings_changed", { setting: BOT_NOTIFY_ACCOUNT_KEYS[key], value: next, scope: "account" });
    return next;
  },

  applyAccount(values): void {
    set(values);
    persist(get());
  },
}));

/** Переключатель по ключу настройки аккаунта; чужой ключ — `undefined`. */
export function botNotifyKeyOf(accountKey: string): BotNotifyKey | undefined {
  return BOT_NOTIFY_KEYS.find((key) => BOT_NOTIFY_ACCOUNT_KEYS[key] === accountKey);
}

function readStored(): BotNotifySettings {
  const stored = value().read();
  return { friendRequest: stored.friendRequest, friendGift: stored.friendGift, teamMessage: stored.teamMessage };
}

function persist(state: BotNotifySettings): void {
  value().write({ friendRequest: state.friendRequest, friendGift: state.friendGift, teamMessage: state.teamMessage });
}

function value(): ReturnType<typeof createPersistedValue<Stored>> {
  return createPersistedValue<Stored>({
    storage: useShell.getState().storage,
    key: STORAGE_KEY,
    schema,
    fallback: { ...BOT_NOTIFY_DEFAULTS },
    onBroken: (key, reason) => reportError("bot-notifications", `${key}: ${reason}`),
  });
}
