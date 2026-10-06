import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { UnavailableError, ValidationError } from "../../common/domain-error.js";
import { Messengers, type SendOutcome } from "../../platforms/ports/messenger.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { LinksService } from "../links/links.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { BROADCAST_RULES } from "./broadcast-rules.js";
import { messageOf } from "./broadcast-sender.js";
import { BroadcastApprovalRequiredError, BroadcastNotFoundError, BroadcastStateError } from "./broadcasts-errors.js";
import { BroadcastsQueue } from "./broadcasts-queue.js";
import { BROADCASTS_REPOSITORY, type BroadcastRecord, type BroadcastStatus, type BroadcastsRepository, type DeliveryStats } from "./broadcasts.repository.js";
import type { Segment } from "./segment.js";

/**
 * Рассылки в бота из панели (docs/29-admin-panel.md §7, docs/35-stage4-plan.md
 * §3.10) — базовые: сегмент, оценка аудитории, тест себе, одобрение, старт,
 * пауза, отмена, итог.
 *
 * - черновик правит `broadcast.edit`, запускает и останавливает
 *   `broadcast.send`, одобряет `broadcast.approve`;
 * - аудитория больше `approvalAudience` — правило двух ключей: одобрить
 *   должен не тот, кто запускает;
 * - кнопка ведёт через ссылку кампании рассылки (`/r/<код>`): клики и
 *   запуски видны в разделе «Ссылки» и в итоге рассылки;
 * - каждое действие — в аудит.
 *
 * Событий аналитики модуль не шлёт: рассылку порождает сервер, а конверт
 * события привязан к устройству (docs/22-analytics-and-metrics.md §3.3). Данные
 * — строки `broadcast` и `broadcast_delivery`.
 */

export interface BroadcastInput {
  title: string;
  platform: PlatformId;
  text: string;
  buttonText: string | null;
  segment: Segment;
}

export type BroadcastEdit = Omit<BroadcastInput, "platform">;

export interface BroadcastView extends BroadcastRecord {
  /** итог доставки; у черновика — `null` */
  stats: DeliveryStats | null;
  /** порог аудитории: больше — старт только после одобрения второго человека */
  approvalAudience: number;
}

@Injectable()
export class BroadcastsService {
  constructor(
    @Inject(BROADCASTS_REPOSITORY) private readonly broadcasts: BroadcastsRepository,
    private readonly roles: RolesService,
    private readonly links: LinksService,
    private readonly messengers: Messengers,
    private readonly queue: BroadcastsQueue,
  ) {}

  async list(actor: AccountRef): Promise<BroadcastRecord[]> {
    await this.roles.require(actor, "broadcast.edit");
    return await this.broadcasts.list(100);
  }

  async view(actor: AccountRef, broadcastId: string): Promise<BroadcastView> {
    await this.roles.require(actor, "broadcast.edit");
    const broadcast = await this.found(broadcastId);
    const stats = broadcast.status === "draft" ? null : await this.broadcasts.stats(broadcastId);
    return { ...broadcast, stats, approvalAudience: BROADCAST_RULES.approvalAudience };
  }

  async estimate(actor: AccountRef, platform: PlatformId, segment: Segment): Promise<{ audience: number }> {
    await this.roles.require(actor, "broadcast.edit");
    return { audience: await this.broadcasts.count(platform, segment) };
  }

  async create(actor: AccountRef, input: BroadcastInput): Promise<BroadcastRecord> {
    await this.roles.require(actor, "broadcast.edit");
    if (this.messengers.for(input.platform) === null) throw new ValidationError("У этой площадки нет бота, которым мы пишем");
    const broadcastId = randomUUID();

    let button: { linkCode: string; buttonUrl: string } | null = null;
    if (input.buttonText !== null) {
      const link = await this.links.create(actor, {
        campaign: `bc-${broadcastId.slice(0, 8)}`,
        source: "broadcast",
        medium: "bot",
        note: input.title.slice(0, 200),
        platform: input.platform,
      });
      // Кнопка Telegram принимает только полный адрес: без домена клиента ссылку не собрать.
      if (!link.url.startsWith("https://")) throw new ValidationError("Кнопке нужен адрес клиента — TELEGRAM_WEBAPP_URL не задан");
      button = { linkCode: link.code, buttonUrl: link.url };
    }

    const broadcast = await this.broadcasts.create({
      broadcastId,
      title: input.title,
      platform: input.platform,
      text: input.text,
      buttonText: input.buttonText,
      buttonUrl: button?.buttonUrl ?? null,
      linkCode: button?.linkCode ?? null,
      segment: input.segment,
      createdBy: actor.accountId,
    });
    await this.audit(actor, "broadcast.create", broadcastId, { title: input.title, platform: input.platform, segment: input.segment });
    return broadcast;
  }

  async update(actor: AccountRef, broadcastId: string, edit: BroadcastEdit): Promise<BroadcastRecord> {
    await this.roles.require(actor, "broadcast.edit");
    const before = await this.found(broadcastId);
    // Ссылка кампании заводится при создании: кнопка без неё вела бы мимо счёта кликов.
    if (edit.buttonText !== null && before.linkCode === null) throw new ValidationError("Кнопку добавляют при создании рассылки — создайте новую");
    const after = await this.broadcasts.updateDraft(broadcastId, { title: edit.title, text: edit.text, buttonText: edit.buttonText, segment: edit.segment });
    if (after === null) throw new BroadcastStateError("Рассылка уже запущена — правка закрыта");
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "broadcast.update",
      target: broadcastId,
      before: { title: before.title, text: before.text, segment: before.segment, approvedBy: before.approvedBy },
      after: { title: after.title, text: after.text, segment: after.segment },
    });
    return after;
  }

  /** Тест себе — в свой чат с ботом площадки рассылки: так видно ровно то, что получат игроки. */
  async testSend(actor: AccountRef, broadcastId: string): Promise<SendOutcome> {
    await this.roles.require(actor, "broadcast.edit");
    const broadcast = await this.found(broadcastId);
    if (actor.platform !== broadcast.platform) throw new ValidationError("Тест уходит в ваш чат с ботом площадки рассылки — войдите в панель с неё");
    const messenger = this.messengers.for(broadcast.platform);
    if (messenger === null) throw new UnavailableError("Бот площадки не настроен");
    return await messenger.send(actor.platformUserId, messageOf(broadcast));
  }

  async approve(actor: AccountRef, broadcastId: string): Promise<BroadcastRecord> {
    await this.roles.require(actor, "broadcast.approve");
    await this.found(broadcastId);
    if (!(await this.broadcasts.approve(broadcastId, actor.accountId))) throw new BroadcastStateError("Одобрить можно только черновик");
    await this.audit(actor, "broadcast.approve", broadcastId, {});
    return await this.found(broadcastId);
  }

  async start(actor: AccountRef, broadcastId: string, now = new Date()): Promise<{ audience: number }> {
    await this.roles.require(actor, "broadcast.send");
    const broadcast = await this.found(broadcastId);
    if (broadcast.status !== "draft") throw new BroadcastStateError("Рассылка уже запущена или закрыта");
    if (this.messengers.for(broadcast.platform) === null) throw new UnavailableError("Бот площадки не настроен");

    const audience = await this.broadcasts.count(broadcast.platform, broadcast.segment);
    if (audience === 0) throw new ValidationError("В аудитории никого — писать некому");
    if (audience > BROADCAST_RULES.approvalAudience && (broadcast.approvedBy === null || broadcast.approvedBy === actor.accountId)) {
      throw new BroadcastApprovalRequiredError(BROADCAST_RULES.approvalAudience);
    }

    const enqueued = await this.broadcasts.start(broadcastId, actor.accountId, now);
    if (enqueued === null) throw new BroadcastStateError("Рассылку уже запустили");
    await this.audit(actor, "broadcast.start", broadcastId, { audience: enqueued, approvedBy: broadcast.approvedBy });
    await this.queue.kick(broadcastId);
    return { audience: enqueued };
  }

  async pause(actor: AccountRef, broadcastId: string): Promise<BroadcastRecord> {
    return await this.move(actor, broadcastId, ["sending"], "paused", "Поставить на паузу можно только идущую рассылку");
  }

  async resume(actor: AccountRef, broadcastId: string): Promise<BroadcastRecord> {
    const broadcast = await this.move(actor, broadcastId, ["paused"], "sending", "Продолжить можно только рассылку на паузе");
    await this.queue.kick(broadcastId);
    return broadcast;
  }

  /** Отмена необратима: неотправленное так и останется в очереди с отметкой в итоге. */
  async cancel(actor: AccountRef, broadcastId: string): Promise<BroadcastRecord> {
    return await this.move(actor, broadcastId, ["draft", "sending", "paused"], "cancelled", "Рассылка уже закончена");
  }

  private async move(actor: AccountRef, broadcastId: string, from: readonly BroadcastStatus[], to: BroadcastStatus, refusal: string): Promise<BroadcastRecord> {
    await this.roles.require(actor, "broadcast.send");
    const before = await this.found(broadcastId);
    if (!(await this.broadcasts.transition(broadcastId, from, to, new Date()))) throw new BroadcastStateError(refusal);
    await this.roles.audit({ actorAccountId: actor.accountId, action: `broadcast.${to}`, target: broadcastId, before: { status: before.status }, after: { status: to } });
    return await this.found(broadcastId);
  }

  private async found(broadcastId: string): Promise<BroadcastRecord> {
    const broadcast = await this.broadcasts.byId(broadcastId);
    if (broadcast === null) throw new BroadcastNotFoundError();
    return broadcast;
  }

  private async audit(actor: AccountRef, action: string, target: string, after: Record<string, unknown>): Promise<void> {
    await this.roles.audit({ actorAccountId: actor.accountId, action, target, after });
  }
}
