import { MembershipRejectedError, MembershipUnavailableError, type ChannelMembership } from "../ports/channel-membership.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Подписка на канал или участие в чате Telegram — по `getChatMember`
 * (docs/35-stage4-plan.md Р52). Бот обязан быть администратором канала:
 * иначе Telegram участников не показывает, и это настройка задания, а не
 * ответ «не подписан».
 */

export type MembershipBotApi = Pick<TelegramBotApi, "getChatMember">;

/** Состоит: участник, администратор, владелец. `restricted` — по своему признаку. */
const MEMBER_STATUSES: ReadonlySet<string> = new Set(["member", "administrator", "creator"]);

/** Telegram не знает этого игрока в чате — значит, не состоит. */
const NOT_PARTICIPANT = /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|user not found/i;

const TELEGRAM_USER_ID = /^\d{1,20}$/;

export class TelegramChannelMembership implements ChannelMembership {
  readonly platform = "telegram" as const;

  /** @param enabled бот настроен — без токена спросить некого */
  constructor(
    private readonly api: MembershipBotApi,
    private readonly enabled: boolean,
  ) {}

  async isMember(chat: string, platformUserId: string): Promise<boolean> {
    if (!this.enabled) throw new MembershipUnavailableError("бот не настроен");
    // Аккаунт разработчика (`dev-…`) в Telegram не существует — ни в каком канале его нет.
    if (!TELEGRAM_USER_ID.test(platformUserId)) return false;
    try {
      const member = await this.api.getChatMember(chat, Number(platformUserId));
      if (member.status === "restricted") return member.isMember === true;
      return MEMBER_STATUSES.has(member.status);
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      if (error.errorCode === 400 && NOT_PARTICIPANT.test(error.message)) return false;
      // Канала нет, бота в нём нет, нет права видеть участников: повтор не поможет.
      if (error.errorCode === 400 || error.errorCode === 403) throw new MembershipRejectedError(error.message);
      throw new MembershipUnavailableError(error.message);
    }
  }
}
