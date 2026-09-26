import { Inject, Injectable, Logger } from "@nestjs/common";
import { AppLinks } from "../../platforms/ports/app-links.js";
import { Messengers, type SendOutcome } from "../../platforms/ports/messenger.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { MessagingService } from "../messaging/messaging.service.js";
import { friendStartParam } from "./friend-code.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "./friends.repository.js";

/**
 * Сообщение о заявке в друзья от бота площадки (docs/35-stage4-plan.md §3.8:
 * «можно писать игроку — приходит сообщение»). Служебное: одно на заявку,
 * только тому, кому можно писать.
 *
 * Кнопка «Принять» открывает игру по ссылке дружбы позвавшего — вход по ней
 * и есть согласие: дружба заводится тем же путём, что по ссылке из чата, а
 * встречная заявка при этом исполняется.
 */

export type NotifyOutcome = SendOutcome["status"] | "skipped";

/** Имя — чужой текст в нашем сообщении: короче, чтобы не растянуть уведомление. */
const NAME_MAX = 64;

export function requestText(name: string): string {
  const short = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
  return `${short} зовёт вас в друзья в «Рубеже». Примите — и сможете каждый день дарить друг другу подарки.`;
}

@Injectable()
export class FriendNotifier {
  private readonly logger = new Logger("friends");

  constructor(
    @Inject(FRIENDS_REPOSITORY) private readonly friends: FriendsRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly messaging: MessagingService,
    private readonly messengers: Messengers,
    private readonly appLinks: AppLinks,
  ) {}

  async requestSent(fromId: string, toId: string): Promise<NotifyOutcome> {
    const [from, to, state] = await Promise.all([this.accounts.byId(fromId), this.accounts.byId(toId), this.messaging.state(toId)]);
    if (from === null || to === null || state?.canMessage !== true) return "skipped";
    const messenger = this.messengers.for(to.platform);
    if (messenger === null) return "skipped";

    const url = this.appLinks.launch(to.platform, friendStartParam(await this.friends.linkOf(fromId)));
    const outcome = await messenger.send(to.platformUserId, { text: requestText(from.displayName), button: url === null ? null : { text: "Принять", url } });
    if (outcome.status === "blocked") await this.messaging.platformChanged(to.platform, to.platformUserId, "blocked", new Date());
    if (outcome.status !== "sent") this.logger.log(JSON.stringify({ module: "friends", event: "friend_request_notify_skipped", toId, outcome: outcome.status }));
    return outcome.status;
  }
}
