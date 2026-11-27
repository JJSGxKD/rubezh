import { Inject, Injectable, Logger } from "@nestjs/common";
import { NotifyTargets } from "../../modules/settings/notify-targets.js";
import { SETTINGS } from "../../modules/settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../../modules/settings/settings.service.js";
import type { ChatTarget } from "../ports/chat-target.js";
import { TELEGRAM_BOT_API, TelegramApiError, type InlineButton, type SendOptions, type TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Эфемерные ответы в чате команды (docs/35-stage4-plan.md Р199, WP52): `/help`,
 * меню выгрузки и отказы видит только спросивший. Вся логика — здесь, чтобы
 * модули `export` и `feedback` не знали ни про ключи, ни про правила
 * Telegram.
 *
 * Эфемерное сообщение Telegram доставить не обещает, а ответ на эфемерную
 * команду принимает 15 секунд. Поэтому им отвечаем только на то, что не жалко
 * потерять, а при отказе площадки (`400`, `403`) возвращаем прежний вид ответа.
 * Данные (статус и архив выгрузки) сюда не попадают никогда.
 */

export type TeamEphemeralApi = Pick<TelegramBotApi, "sendMessage" | "answerCallbackQuery">;
export type TelegramMessage = NonNullable<TelegramUpdate["message"]>;
export type TelegramCallbackQuery = NonNullable<TelegramUpdate["callback_query"]>;

/** Ключи, от которых зависит меню команд чата команды. */
const SWITCH_KEYS: readonly string[] = ["bot.formats.enabled", "bot.team-ephemeral.enabled"];

/** Чаты команды без повторов: туда пишет бот, и там команды администратора видны всем участникам. */
export function teamChatsOf(targets: NotifyTargets): ChatTarget[] {
  const chats = targets.chats();
  const all = [chats.general, chats.stats, chats.stressReports, chats.runReports].filter((chat): chat is ChatTarget => chat !== null);
  return all.filter((chat, index) => all.findIndex((other) => other.chatId === chat.chatId) === index);
}

@Injectable()
export class TeamEphemeral {
  private readonly logger = new Logger("bot");
  private refusalLogged = false;

  constructor(
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly targets: NotifyTargets,
    @Inject(TELEGRAM_BOT_API) private readonly api: TeamEphemeralApi,
  ) {}

  /** Оба ключа включены: `bot.formats.enabled` и `bot.team-ephemeral.enabled`. */
  enabled(): boolean {
    return this.settings.get(SETTINGS.botFormatsEnabled) && this.settings.get(SETTINGS.botTeamEphemeralEnabled);
  }

  teamChats(): ChatTarget[] {
    return teamChatsOf(this.targets);
  }

  isTeamChat(chatId: string): boolean {
    return this.teamChats().some((chat) => chat.chatId === chatId);
  }

  /** Ключи поменялись в панели — меню команд надо переставить. */
  onSwitchChange(listener: () => void): void {
    this.settings.onChange((changed) => {
      if (changed.some((key) => SWITCH_KEYS.includes(key))) listener();
    });
  }

  /**
   * Эфемерный ответ на команду в чате команды. `false` — так ответить нельзя
   * (выключено, не чат команды, нет автора, площадка отказала), и
   * вызывающий отвечает по-старому.
   */
  async tryReply(message: TelegramMessage, text: string, options: { keyboard?: InlineButton[][] } = {}): Promise<boolean> {
    if (!this.enabled() || message.from === undefined) return false;
    const chatId = String(message.chat.id);
    if (!this.isTeamChat(chatId)) return false;
    const sent = await this.send({ chatId, threadId: message.message_thread_id ?? null }, text, {
      ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
      ephemeral: {
        receiverUserId: message.from.id,
        ...(message.ephemeral_message_id === undefined ? {} : { replyToEphemeralId: message.ephemeral_message_id }),
      },
    });
    if (sent) this.logger.log(JSON.stringify({ module: "bot", event: "team_ephemeral", kind: "reply" }));
    return sent;
  }

  /**
   * Ответ на нажатие. В чате команды при включённых ключах — эфемерное
   * сообщение нажавшему и пустой `answerCallbackQuery`; иначе или при отказе —
   * `answerCallbackQuery(id, text)`, как до задачи. Нажатие гасится всегда
   * ровно одним `answerCallbackQuery`.
   */
  async answerPress(query: TelegramCallbackQuery, text: string): Promise<void> {
    const chat = query.message?.chat;
    if (chat !== undefined && this.enabled() && this.isTeamChat(String(chat.id))) {
      const sent = await this.send({ chatId: String(chat.id), threadId: query.message?.message_thread_id ?? null }, text, {
        ephemeral: { receiverUserId: query.from.id, callbackQueryId: query.id },
      });
      if (sent) {
        this.logger.log(JSON.stringify({ module: "bot", event: "team_ephemeral", kind: "press" }));
        await this.api.answerCallbackQuery(query.id);
        return;
      }
    }
    await this.api.answerCallbackQuery(query.id, text);
  }

  /** Отказ площадки (`400`, `403`) — `false`; остальные ошибки бросаются, задание очереди повторит. */
  private async send(chat: { chatId: string; threadId: number | null }, text: string, options: SendOptions): Promise<boolean> {
    try {
      await this.api.sendMessage(chat, text, undefined, options);
      return true;
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError) || (error.errorCode !== 400 && error.errorCode !== 403)) throw error;
      if (!this.refusalLogged) {
        this.refusalLogged = true;
        this.logger.warn(JSON.stringify({ module: "bot", event: "team_ephemeral_refused", method: error.method, code: error.errorCode }));
      }
      return false;
    }
  }
}
