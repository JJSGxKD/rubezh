import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../../common/with-timeout.js";
import { parseChatTarget } from "../../../platforms/ports/chat-target.js";
import { Messengers } from "../../../platforms/ports/messenger.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../../auth/account.repository.js";
import { NotifyTargets } from "../../settings/notify-targets.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../../settings/settings.service.js";
import type { OperationsChart } from "./builders.js";
import type { OperationInput, OperationKind } from "./operation-input.js";

/**
 * Сообщения команде о втором ключе на операции учёта (docs/29-admin-panel.md §4, Р220, tasks/T-0462): карточка
 * «операция на подтверждении» — когда финансы внесли крупное или исправление, и ответ о решении владельца. Поток —
 * «Бухгалтерия» (`notify.chat.finance`), пока он не задан — общий чат, как у остальных потоков. Отправка — портом
 * `Messengers`: домен не знает, как площадка шлёт в чат.
 *
 * **Не бросает и не ждёт.** Операция уже записана и ждёт решения, а решение уже принято и записано в журнал: упавшее
 * сообщение — предупреждение в логе, а не отказ запроса. Вызывающий не дожидается отправки (`OperationApprovals`).
 *
 * Решение уходит следующим сообщением в тот же поток, а не ответом на карточку: порт `Messengers` ответов на
 * сообщение не умеет, и расширять его ради одной строки не стали. Строка решения повторяет суть карточки, поэтому
 * видна и без неё.
 */

const SEND_TIMEOUT_MS = 10_000;
const NAMES_TIMEOUT_MS = 3_000;

const KIND_NAMES: Readonly<Record<OperationKind, string>> = {
  transfer: "перевод",
  exchange: "обмен",
  expense: "расход",
  income: "поступление",
  loan: "заём",
  reversal: "исправление",
};

/** Что нужно знать сообщению об операции: человеческая суть, а не строки проводки. */
export interface OperationCard {
  operationId: string;
  kind: OperationKind;
  /** сумма и валюта словами: «20000 RUB», «100 USDT → 9000 RUB», «проводки «op:…»» у исправления */
  summary: string;
  /** оценка в долларах на момент ввода; `null` — курса не было */
  amountUsd: string | null;
  /** кто внёс: имя подбирается при отправке */
  authorId: string;
  note: string;
}

export interface DecisionNotice {
  approved: boolean;
  deciderId: string;
  /** комментарий владельца; при отказе — причина */
  note: string | null;
}

/** Сумма операции словами для сообщения: в валюте места, как её ввёл человек. */
export function operationSummary(input: OperationInput, chart: OperationsChart): string {
  const currencyOf = (placeId: string): string => chart.places.get(placeId)?.currency ?? "?";
  switch (input.kind) {
    case "transfer":
      return `${input.amount} ${currencyOf(input.from)}`;
    case "exchange":
      return `${input.given} ${currencyOf(input.from)} → ${input.received} ${currencyOf(input.to)}`;
    case "expense":
      return `${input.amount} ${currencyOf(input.from)}`;
    case "income":
      return `${input.amount} ${currencyOf(input.to)}`;
    case "loan":
      return `${input.amount} ${currencyOf(input.to)}`;
    case "reversal":
      return `проводки «${input.sourceKey}»`;
  }
}

/** Оценка в долларах: у исправления размера нет вовсе, а у остальных «курса не было» — тоже сведение для владельца. */
function estimateOf(card: OperationCard): string {
  if (card.kind === "reversal") return "";
  return card.amountUsd === null ? " (курса не было)" : ` (≈ ${card.amountUsd} $)`;
}

function headline(card: OperationCard, authorName: string): string {
  return `${KIND_NAMES[card.kind]} ${card.summary}${estimateOf(card)} — ${authorName}: «${card.note}»`;
}

/** Текст карточки — для человека в чате: что внесли, кто, зачем и где подтвердить. */
export function pendingText(card: OperationCard, authorName: string): string {
  return [
    `💼 Операция на подтверждении: ${headline(card, authorName)}`,
    `Номер: ${card.operationId}`,
    "Подтвердить или отклонить может владелец — в панели: «Бухгалтерия» → «Операции». Пока решения нет, проводки в журнале нет.",
  ].join("\n");
}

/** Текст решения — для человека в чате: что решили по карточке и кто. */
export function decidedText(card: OperationCard, authorName: string, decision: { approved: boolean; deciderName: string; note: string | null }): string {
  const verdict = decision.approved ? "подтверждено" : `отклонено: ${decision.note ?? "без причины"}`;
  return [
    `${decision.approved ? "✅" : "⛔"} Операция: ${headline(card, authorName)}`,
    `Решение: ${verdict} (${decision.deciderName})`,
    ...(decision.approved && decision.note !== null ? [`Комментарий: ${decision.note}`] : []),
  ].join("\n");
}

@Injectable()
export class OperationsNotifier {
  private readonly logger = new Logger("ledger-operations");

  constructor(
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly targets: NotifyTargets,
    private readonly messengers: Messengers,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "displayNames">,
  ) {}

  /** Карточка «на подтверждении». Не бросает. */
  async pending(card: OperationCard): Promise<void> {
    try {
      const names = await this.names([card.authorId]);
      await this.send(card.operationId, pendingText(card, names.get(card.authorId) ?? card.authorId));
    } catch (error: unknown) {
      this.warn("pending_failed", card.operationId, error);
    }
  }

  /** Ответ о решении владельца. Не бросает. */
  async decided(card: OperationCard, decision: DecisionNotice): Promise<void> {
    try {
      const names = await this.names([card.authorId, decision.deciderId]);
      await this.send(
        card.operationId,
        decidedText(card, names.get(card.authorId) ?? card.authorId, { approved: decision.approved, deciderName: names.get(decision.deciderId) ?? decision.deciderId, note: decision.note }),
      );
    } catch (error: unknown) {
      this.warn("decided_failed", card.operationId, error);
    }
  }

  /** Имена не нашлись — не повод молчать: сообщение уйдёт с идентификатором. */
  private async names(accountIds: readonly string[]): Promise<Map<string, string>> {
    try {
      return await withTimeout(this.accounts.displayNames([...new Set(accountIds)]), NAMES_TIMEOUT_MS, "имена аккаунтов");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "ledger-operations", event: "names_unread", reason: error instanceof Error ? error.message : "unknown" }));
      return new Map();
    }
  }

  private async send(operationId: string, text: string): Promise<void> {
    const target = parseChatTarget(this.settings.get(SETTINGS.chatFinance)) ?? this.targets.chats().general;
    const messenger = this.messengers.for("telegram");
    if (target === null || messenger === null || messenger.sendToChat === undefined) {
      this.logger.warn(JSON.stringify({ module: "ledger-operations", event: "no_chat", operationId }));
      return;
    }
    const outcome = await withTimeout(messenger.sendToChat(target, text), SEND_TIMEOUT_MS, "сообщение в чат команды");
    if (outcome.status !== "sent") this.logger.warn(JSON.stringify({ module: "ledger-operations", event: "not_sent", operationId, outcome: outcome.status }));
  }

  private warn(event: string, operationId: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "ledger-operations", event, operationId, reason: error instanceof Error ? error.message : "unknown" }));
  }
}
