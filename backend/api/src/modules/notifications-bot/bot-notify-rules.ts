import { isNotificationKind, type NotificationKind } from "../notifications/notification-kinds.js";

/**
 * Какие уведомления дублируются в бота (docs/35-stage4-plan.md Р51, WP28) —
 * по выбору игрока и только тем, кому можно писать (§3.10). В бота идёт то,
 * что зовёт вернуться в игру: заявка и подарок друга, сообщение команды.
 * О выходе версии бот не пишет: она остаётся в ленте и «Что нового», о
 * крупных обновлениях команда пишет рассылкой (решение 06.10.2026).
 * Редкая добыча и возврат бустов случаются, пока игрок в игре, — писать о них
 * в бота незачем.
 *
 * Умолчания повторяет клиент (`app-shell/src/state/bot-notifications.ts`):
 * расхождение ловит `scripts/test/account-settings-keys.test.ts`.
 */

export interface BotNotifyRule {
  /** ключ настройки аккаунта: игрок выбирает в настройках игры */
  setting: string;
  /** пока игрок не выбирал: то, что надоедает, выключено */
  byDefault: boolean;
  /** не чаще одного сообщения этого вида игроку за столько секунд; 0 — без потолка */
  throttleSec: number;
}

export const BOT_NOTIFY: Partial<Record<NotificationKind, BotNotifyRule>> = {
  // Заявки приходят пачкой после поста в канале: одно сообщение в час зовёт
  // в игру, остальные ждут в ленте.
  friend_request: { setting: "bot.friendRequest", byDefault: true, throttleSec: 3_600 },
  // Подарок каждый день от каждого друга — это уже спам: выключен, пока игрок
  // не попросит, и даже тогда не чаще раза в сутки.
  friend_gift: { setting: "bot.friendGift", byDefault: false, throttleSec: 86_400 },
  // Сообщение команды редкое и адресное: потолка нет.
  team_message: { setting: "bot.teamMessage", byDefault: true, throttleSec: 0 },
};

export function botRuleOf(kind: string): BotNotifyRule | undefined {
  return isNotificationKind(kind) ? BOT_NOTIFY[kind] : undefined;
}

/**
 * Темп дубля на всю очередь и все реплики. Рядом идут рассылки — 25 в секунду
 * у Telegram (`telegram-messenger.ts`), вместе — под общим потолком площадки.
 */
export const BOT_NOTIFY_PER_SEC = 5;
