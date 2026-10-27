import { containsMention, type BotMention, type MentionFinding, type MentionKind, type MentionOutcome } from "../ports/bot-mention.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Юзернейм бота в имени и bio игрока — по `getChat` (docs/35-stage4-plan.md
 * Р110, tasks/T-0159): имя и bio приходят одним запросом, поэтому порт
 * принимает список видов. Текст имени и bio не сохраняется и в лог не
 * пишется — наружу уходит только итог.
 */

export type BotMentionApi = Pick<TelegramBotApi, "getChat">;

const TELEGRAM_USER_ID = /^\d{1,20}$/;

/** Подождать, когда Telegram не назвал срок или связь сбойнула. */
const DEFAULT_RETRY_SEC = 5;

export class TelegramBotMention implements BotMention {
  readonly platform = "telegram" as const;
  /** Как у `TelegramMessenger`: общий лимит бота делят рассылки и проверки. */
  readonly ratePerSec = 25;

  /**
   * @param username юзернейм бота: узнаётся на старте (`getMe`), до этого `null`
   * @param enabled бот настроен — без токена спросить некого
   */
  constructor(
    private readonly api: BotMentionApi,
    private readonly username: () => string | null,
    private readonly enabled: boolean,
  ) {}

  get configured(): boolean {
    return this.enabled && this.username() !== null;
  }

  botUsername(): string | null {
    return this.username();
  }

  async check(platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome> {
    // Аккаунт разработчика (`dev-…`) в Telegram не существует — проверять нечего.
    if (!TELEGRAM_USER_ID.test(platformUserId)) return { status: "unavailable", reason: "not_platform_account" };
    const bot = this.username();
    if (bot === null || !this.enabled) return { status: "unavailable", reason: "bot_unknown" };

    try {
      const chat = await this.api.getChat(Number(platformUserId));
      const findings: Partial<Record<MentionKind, MentionFinding>> = {};
      for (const kind of kinds) {
        if (kind === "name") {
          const name = [chat.firstName, chat.lastName].filter((part) => part !== null).join(" ");
          findings.name = containsMention(name, bot) ? "present" : "absent";
        } else {
          findings.bio = chat.bio === null ? "hidden" : containsMention(chat.bio, bot) ? "present" : "absent";
        }
      }
      return { status: "checked", findings };
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      if (error.errorCode === 429) return { status: "retry", afterSec: error.retryAfterSec ?? DEFAULT_RETRY_SEC };
      if (error.errorCode === 0 || error.errorCode >= 500) return { status: "retry", afterSec: DEFAULT_RETRY_SEC };
      // Текст ошибки может нести имя игрока: в причину идёт только код.
      return { status: "unavailable", reason: String(error.errorCode) };
    }
  }
}
