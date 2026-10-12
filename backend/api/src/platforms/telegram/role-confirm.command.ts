import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ROLE_CONFIRM_PREFIX, RoleConfirmations, type RoleConfirmPrompt, type RoleConfirmVerdict } from "../../modules/admin/role-confirmations.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import { TELEGRAM_BOT_API, type TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Подтверждение выдачи роли владельца или администратора в боте
 * (docs/29-admin-panel.md §3.4). Ссылка из панели открывает бота с
 * `/start role-<запрос>`; бот показывает, кому и какую роль выдают, и ждёт
 * «Выдать» или «Отмена». Только в личном чате: в группе кнопку нажал бы кто
 * угодно из участников, а сверка Telegram ID с открывшим запрос — в домене.
 */

export type RoleConfirmBotApi = Pick<TelegramBotApi, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

const START = new RegExp(`^/start(?:@\\w+)?\\s+${ROLE_CONFIRM_PREFIX}([A-Za-z0-9_-]{22})\\s*$`);
const CALLBACK = /^role:(ok|no):([A-Za-z0-9_-]{22})$/;

const EXPIRED_TEXT = "Запрос на выдачу роли истёк или уже решён. Откройте выдачу в панели заново.";
const FOREIGN_TEXT = "Этот запрос открыт другим человеком — подтвердить его может только он.";

const VERDICT_TEXTS: Record<RoleConfirmVerdict | "declined", string> = {
  granted: "✅ Роль выдана. Права действуют сразу.",
  already: "У аккаунта уже есть эта роль.",
  expired: EXPIRED_TEXT,
  foreign: FOREIGN_TEXT,
  no_right: "У вас больше нет права выдавать роли.",
  declined: "Выдача отменена.",
};

@Injectable()
export class RoleConfirmCommand implements BotUpdateHandler, OnModuleInit, OnModuleDestroy {
  readonly name = "role-confirm";
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(TELEGRAM_BOT_API) private readonly api: RoleConfirmBotApi,
    private readonly confirmations: RoleConfirmations,
  ) {}

  /** Без чтения обновлений боту нечего подтверждать, без входа нет и панели. */
  onModuleInit(): void {
    if (this.config.telegram.updates !== "off" && this.config.admin.enabled) this.router.register(this);
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    if (update.callback_query !== undefined) return await this.handleCallback(update.callback_query);
    const message = update.message;
    const match = message?.text === undefined ? null : START.exec(message.text);
    if (message === undefined || match === null || message.from === undefined || message.from.is_bot) return false;
    const requestId = match[1] ?? "";
    const chatId = String(message.chat.id);
    if (message.chat.type !== "private" || chatId !== String(message.from.id)) {
      await this.api.sendMessage(chatId, "Выдачу роли подтверждают в личном чате с ботом.", this.stop.signal);
      return true;
    }
    const prompt = await this.confirmations.prompt(requestId, String(message.from.id));
    if (prompt === "expired" || prompt === "foreign") {
      await this.api.sendMessage(chatId, prompt === "expired" ? EXPIRED_TEXT : FOREIGN_TEXT, this.stop.signal);
      return true;
    }
    await this.api.sendMessage(chatId, promptText(prompt), this.stop.signal, {
      keyboard: [
        [
          { text: "Выдать", callback_data: `role:ok:${requestId}` },
          { text: "Отмена", callback_data: `role:no:${requestId}` },
        ],
      ],
    });
    return true;
  }

  private async handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<boolean> {
    const match = CALLBACK.exec(query.data ?? "");
    if (match === null) return false;
    const [, action, requestId = ""] = match;
    const chat = query.message?.chat;
    // Кнопка из пересланного сообщения или из группы — не подтверждение того, кому она пришла.
    if (chat === undefined || chat.type !== "private" || String(chat.id) !== String(query.from.id) || query.message === undefined) {
      await this.api.answerCallbackQuery(query.id, undefined, this.stop.signal);
      this.logger.warn(JSON.stringify({ module: "bot", event: "role_confirm_foreign_button", from: String(query.from.id) }));
      return true;
    }
    const from = String(query.from.id);
    const verdict: RoleConfirmVerdict | "declined" = action === "ok" ? await this.confirmations.confirm(requestId, from) : (await this.confirmations.decline(requestId, from)) ? "declined" : "expired";
    await this.api.answerCallbackQuery(query.id, verdict === "granted" ? "Готово" : undefined, this.stop.signal);
    await this.api.editMessageText(String(chat.id), query.message.message_id, VERDICT_TEXTS[verdict], this.stop.signal);
    return true;
  }
}

/** Текст перед подтверждением: кому и что выдают, и что делать, если запрос не свой. */
export function promptText(prompt: RoleConfirmPrompt): string {
  return [
    `Выдать роль «${prompt.roleTitle}» аккаунту ${prompt.targetName} (Telegram ID ${prompt.targetPlatformUserId})?`,
    "Запрос открыт из вашей сессии панели. Если вы его не открывали — нажмите «Отмена» и выйдите из панели везде.",
  ].join("\n");
}
