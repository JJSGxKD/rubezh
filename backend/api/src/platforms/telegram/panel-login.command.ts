import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { PANEL_LOGIN_PREFIX, PanelLoginService, type PanelLoginConfirmer, type PanelLoginVerdict } from "../../modules/admin/panel-login.service.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import { TELEGRAM_BOT_API, type TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Подтверждение входа в панель в боте (docs/29-admin-panel.md §8). Ссылка из
 * панели открывает бота с `/start panel-<запрос>`; бот показывает код и то,
 * откуда открыт запрос, и ждёт «Войти» или «Это не я». Только в личном чате:
 * в группе кнопку нажал бы кто угодно из участников.
 */

export type PanelLoginBotApi = Pick<TelegramBotApi, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

const START = new RegExp(`^/start(?:@\\w+)?\\s+${PANEL_LOGIN_PREFIX}([A-Za-z0-9_-]{22})\\s*$`);
const CALLBACK = /^panel:(ok|no):([A-Za-z0-9_-]{22})$/;

const VERDICT_TEXTS: Record<PanelLoginVerdict, string> = {
  confirmed: "✅ Вход подтверждён — панель откроется сама через пару секунд.",
  declined: "Вход отклонён. Если ссылку прислал кто-то другой — не открывайте её больше.",
  no_role: "У вашего аккаунта нет роли в панели. Попросите владельца выдать её в разделе «Роли».",
  banned: "Аккаунт заблокирован — в панель с него не войти.",
  expired: "Запрос входа истёк или уже решён. Откройте вход в панели заново.",
};

@Injectable()
export class PanelLoginCommand implements BotUpdateHandler, OnModuleInit, OnModuleDestroy {
  readonly name = "panel-login";
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(TELEGRAM_BOT_API) private readonly api: PanelLoginBotApi,
    private readonly logins: PanelLoginService,
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
      await this.api.sendMessage(chatId, "Вход в панель подтверждают в личном чате с ботом.", this.stop.signal);
      return true;
    }
    const prompt = await this.logins.prompt(requestId);
    if (prompt === null) {
      await this.api.sendMessage(chatId, VERDICT_TEXTS.expired, this.stop.signal);
      return true;
    }
    await this.api.sendMessage(chatId, promptText(prompt), this.stop.signal, {
      keyboard: [
        [
          { text: "Войти", callback_data: `panel:ok:${requestId}` },
          { text: "Это не я", callback_data: `panel:no:${requestId}` },
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
      this.log("warn", "panel_login_foreign_button", { from: String(query.from.id) });
      return true;
    }
    const who = confirmerOf(query.from);
    const verdict: PanelLoginVerdict = action === "ok" ? await this.logins.confirm(requestId, who) : (await this.logins.decline(requestId, who)) ? "declined" : "expired";
    await this.api.answerCallbackQuery(query.id, verdict === "confirmed" ? "Готово" : undefined, this.stop.signal);
    await this.api.editMessageText(String(chat.id), query.message.message_id, VERDICT_TEXTS[verdict], this.stop.signal);
    return true;
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "bot", event, ...fields }));
  }
}

/** Текст перед подтверждением: сверить код и узнать своё устройство — главная защита от чужой ссылки. */
export function promptText(prompt: { code: string; device: string; place: string; expiresAtMs: number }): string {
  return [
    "🔐 Вход в панель Рубежа",
    "",
    `Код: ${prompt.code}`,
    `Браузер: ${prompt.device}`,
    `Сеть: ${prompt.place}`,
    "",
    "Нажмите «Войти», только если этот код сейчас на вашем экране панели. Ссылку прислал кто-то другой — «Это не я».",
  ].join("\n");
}

function confirmerOf(user: { id: number; first_name?: string | undefined; last_name?: string | undefined; username?: string | undefined }): PanelLoginConfirmer {
  const name = [user.first_name, user.last_name].filter((part): part is string => part !== undefined && part !== "").join(" ");
  return { platform: "telegram", platformUserId: String(user.id), displayName: name === "" ? (user.username ?? String(user.id)) : name, username: user.username ?? null };
}
