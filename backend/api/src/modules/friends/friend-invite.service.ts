import { Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { AppLinks } from "../../platforms/ports/app-links.js";
import { MessagePreparers, type MessagePreparer, type PreparedMessage, type PreparedMessageInput } from "../../platforms/ports/prepared-message.js";
import type { AccessTokenClaims } from "../auth/access-token.js";
import { InviteUnavailableError } from "./friends-errors.js";
import { FriendsService } from "./friends.service.js";

/**
 * Приглашение друга сообщением (docs/35-stage4-plan.md Р63, WP14): бот
 * площадки готовит сообщение с кнопкой в игру по ссылке дружбы, а игрок сам
 * выбирает, в какой чат его отправить. Своим сервисом — сервис друзей и так
 * близок к потолку в 300 строк.
 *
 * Ссылка — та же ссылка дружбы, что у кнопки «Копировать»: открывший её
 * сразу друг, и атрибуция у всех способов одна.
 */

const PREPARE_TIMEOUT_MS = 5_000;

export interface PreparedInvite {
  /** что передать приложению площадки, чтобы открыть выбор чата */
  messageId: string;
  /** до какого времени сообщение можно отправить; `null` — площадка не сказала */
  expiresAt: string | null;
}

/**
 * Текст приглашения. Простой, без разметки и без рода: пишет игрок от своего
 * имени, и «позвал» или «позвала» мы не знаем.
 */
export function inviteMessage(url: string): PreparedMessageInput {
  return {
    title: "Играть вместе в «Рубеж»",
    description: "Откроешь по кнопке — и мы сразу друзья",
    text: "Зову тебя в «Рубеж» — забеги на несколько минут, прокачка и рейтинг. Открой игру по кнопке — и мы сразу станем друзьями.",
    button: { text: "▶ Играть", url },
  };
}

@Injectable()
export class FriendInviteService {
  private readonly logger = new Logger("friends");

  constructor(
    private readonly friends: FriendsService,
    private readonly links: AppLinks,
    private readonly preparers: MessagePreparers,
  ) {}

  async preparedMessage(actor: AccessTokenClaims): Promise<PreparedInvite> {
    const preparer = this.preparers.for(actor.platform);
    if (preparer === null) throw new InviteUnavailableError("На этой площадке так позвать нельзя — скопируйте ссылку");
    const { startParam } = await this.friends.link(actor.accountId);
    const url = this.links.launch(actor.platform, startParam);
    if (url === null) throw new InviteUnavailableError("Ссылка на игру ещё не готова — попробуйте через минуту");

    const prepared = await this.prepare(preparer, actor, url);
    if (prepared === null) throw new InviteUnavailableError("Для этого аккаунта сообщение не подготовить — скопируйте ссылку");
    return { messageId: prepared.id, expiresAt: prepared.expiresAt?.toISOString() ?? null };
  }

  /** Сбой площадки — понятный отказ игроку и предупреждение в лог, а не «необработанная ошибка». */
  private async prepare(preparer: MessagePreparer, actor: AccessTokenClaims, url: string): Promise<PreparedMessage | null> {
    try {
      return await withTimeout(preparer.prepare(actor.platformUserId, inviteMessage(url)), PREPARE_TIMEOUT_MS, "подготовка приглашения");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "friends", event: "invite_prepare_failed", platform: actor.platform, reason: error instanceof Error ? error.message : "unknown" }));
      throw new InviteUnavailableError("Не удалось подготовить сообщение — попробуйте ещё раз");
    }
  }
}
