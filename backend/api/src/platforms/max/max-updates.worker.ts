import { Logger } from "@nestjs/common";
import type { ExternalIdentityService } from "../../modules/external-identity/external-identity.service.js";
import type { MaxBotApi, MaxLinkButton } from "./max-bot-api.js";
import type { MaxChannelLinks } from "./max-channel-links.js";
import type { MaxBotStarted } from "./max-update.js";

/**
 * Ответы бота MAX на старт (docs/35-stage4-plan.md Р188, tasks/T-0379): игрок
 * нажал «Начать» по ссылке из задания, и бот получил код. Бот отвечает только на
 * старт с кодом; меню, команды и рассылки в MAX — позже.
 *
 * Связь аккаунтов — `ExternalIdentityService.consume`: код забирается атомарно,
 * поэтому повторное применение отдало бы «ссылка устарела». Отсюда порядок
 * ошибок:
 * - связь не записалась (база недоступна) — бросаем: задание очереди повторится;
 * - ответ игроку не ушёл — только лог: связь уже записана, а второй `consume`
 *   того же кода ответил бы «устарела» тому, кто уже связан.
 */

/** Тексты ответов — дословно из tasks/T-0379; на «ты», без рода. */
export const MAX_REPLIES = {
  noCode: "Чтобы связать аккаунт, открой задание в игре и нажми «Открыть бота MAX»",
  linked: "Готово! Аккаунт MAX связан с игрой. Подпишись на канал и вернись в игру — нажми «Проверить».",
  already: "Аккаунт уже связан. Подпишись на канал и нажми «Проверить» в игре.",
  taken: "Этот аккаунт MAX уже связан с другим игроком. Связать его второй раз нельзя.",
  expired: "Ссылка устарела. Открой задание в игре и нажми «Открыть бота MAX» ещё раз.",
} as const;

const CHANNEL_BUTTON = "Открыть канал";

/** Сколько кнопок на каналы в одном ответе: выбор из десяти кнопок уже не подсказка (tasks/T-0379). */
const MAX_CHANNEL_BUTTONS = 3;

export class MaxUpdatesWorker {
  private readonly logger = new Logger("max");

  constructor(
    private readonly identity: Pick<ExternalIdentityService, "consume">,
    private readonly api: Pick<MaxBotApi, "sendMessage">,
    private readonly channels: Pick<MaxChannelLinks, "urls">,
  ) {}

  /** Одно событие `bot_started`. */
  async handle(event: MaxBotStarted): Promise<void> {
    // Другой бот, нажавший «Начать», — не игрок.
    if (event.user.is_bot === true) return;
    const userId = String(event.user.user_id);
    const code = event.payload?.trim() ?? "";
    if (code === "") {
      await this.reply(userId, MAX_REPLIES.noCode);
      return;
    }

    const outcome = await this.identity.consume("max", code, userId);
    if (outcome === "linked" || outcome === "already") await this.reply(userId, MAX_REPLIES[outcome], await this.channelButtons());
    else await this.reply(userId, MAX_REPLIES[outcome]);
  }

  /** Кнопка на каждый канал MAX из каталога заданий; несколько — с номерами, чтобы их можно было различить. */
  private async channelButtons(): Promise<MaxLinkButton[]> {
    let urls: readonly string[];
    try {
      urls = await this.channels.urls();
    } catch (error: unknown) {
      // Каталог не прочитался: ответ без кнопки лучше молчания, связь уже записана.
      this.logger.warn(JSON.stringify({ module: "max", event: "max_channel_links_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return [];
    }
    const shown = urls.slice(0, MAX_CHANNEL_BUTTONS);
    return shown.map((url, index) => ({ text: shown.length === 1 ? CHANNEL_BUTTON : `${CHANNEL_BUTTON} ${String(index + 1)}`, url }));
  }

  private async reply(userId: string, text: string, buttons: readonly MaxLinkButton[] = []): Promise<void> {
    try {
      await this.api.sendMessage(userId, text, buttons);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "max", event: "max_reply_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
