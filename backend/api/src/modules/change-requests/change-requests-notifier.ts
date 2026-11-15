import { Inject, Injectable, Logger } from "@nestjs/common";
import { Messengers } from "../../platforms/ports/messenger.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { NotifyTargets } from "../settings/notify-targets.js";
import { ChangeKindRegistry } from "./change-request-kinds.js";
import { rolesGranting } from "./change-request-rules.js";
import { CHANGE_TTL_HOURS, type ChangeKind, type ChangeRequestView } from "./change-request-types.js";
import { CHANGE_REQUESTS_REPOSITORY, type ChangeRequestsRepository } from "./change-requests.repository.js";

/**
 * О новой заявке — тем, кто может её решить (docs/19-content-admin.md §6,
 * tasks/T-0309): строка ленты уведомлений каждому аккаунту с правом, кроме
 * автора, и сообщение в чат администраторов. Адрес — общий чат: заявка редкая,
 * и отдельный поток под неё не заводился.
 *
 * Не бросает: заявка уже записана, и упавшее уведомление — предупреждение в
 * логе, а не отказ. Лента и чат независимы: сбой одной другую не отменяет.
 */

const KIND_TITLES: Record<ChangeKind, string> = {
  sku_price: "цена товара",
  reward_setting: "награда",
};

/** Имя автора в строке ленты: не длиннее 64 знаков схемы вида. */
const NAME_MAX = 64;

@Injectable()
export class ChangeRequestsNotifier {
  private readonly logger = new Logger("change-requests");

  constructor(
    @Inject(CHANGE_REQUESTS_REPOSITORY) private readonly repository: ChangeRequestsRepository,
    private readonly notifications: NotificationsService,
    private readonly targets: NotifyTargets,
    private readonly messengers: Messengers,
    private readonly kinds: ChangeKindRegistry,
  ) {}

  async requested(request: ChangeRequestView): Promise<void> {
    await this.toFeed(request);
    await this.toChat(request);
  }

  private async toFeed(request: ChangeRequestView): Promise<void> {
    try {
      const peers = (await this.repository.peers(rolesGranting(this.kinds.get(request.kind).permission))).filter((accountId) => accountId !== request.author);
      if (peers.length === 0) return;
      await this.notifications.deliverMany({
        accountIds: peers,
        kind: "change_request_pending",
        payload: { requestId: request.requestId, kind: request.kind, target: request.target, authorName: (request.authorName ?? "Коллега").slice(0, NAME_MAX) },
        dedupeKey: `change_request:${request.requestId}`,
        at: request.createdAt,
      });
    } catch (error: unknown) {
      this.warn("feed_failed", request, error);
    }
  }

  private async toChat(request: ChangeRequestView): Promise<void> {
    try {
      const target = this.targets.chats().general;
      const messenger = this.messengers.for("telegram");
      if (target === null || messenger === null || messenger.sendToChat === undefined) {
        this.logger.warn(JSON.stringify({ module: "change-requests", event: "no_chat", requestId: request.requestId }));
        return;
      }
      const outcome = await messenger.sendToChat(target, this.chatText(request));
      if (outcome.status !== "sent") this.logger.warn(JSON.stringify({ module: "change-requests", event: "chat_not_sent", requestId: request.requestId, outcome: outcome.status }));
    } catch (error: unknown) {
      this.warn("chat_failed", request, error);
    }
  }

  /** Текст — для человека в чате: что меняют, кто, зачем и кто может решить. */
  private chatText(request: ChangeRequestView): string {
    return [
      `📋 Заявка на правку: ${KIND_TITLES[request.kind]}`,
      this.kinds.get(request.kind).describe(request),
      `Автор: ${request.authorName ?? "—"}`,
      `Причина: ${request.reason}`,
      `Подтвердить может другой участник с правом на цены — в панели: «Баланс» → «Цены и награды». Заявка живёт ${String(CHANGE_TTL_HOURS)} часа.`,
    ].join("\n");
  }

  private warn(event: string, request: ChangeRequestView, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "change-requests", event, requestId: request.requestId, reason: error instanceof Error ? error.message : "unknown" }));
  }
}
