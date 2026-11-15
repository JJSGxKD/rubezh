import { Inject, Injectable, Logger } from "@nestjs/common";
import { ForbiddenError } from "../../../common/domain-error.js";
import type { Permission } from "../../roles/permissions.js";
import { RolesService, type AccountRef } from "../../roles/roles.service.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../../settings/settings.service.js";
import type { OperationKind } from "./operation-input.js";
import { OperationsNotifier, type DecisionNotice, type OperationCard } from "./operations-notify.js";

/**
 * Второй ключ на операции учёта (docs/29-admin-panel.md §4, «Правило двух ключей», Р220, tasks/T-0462): крупная
 * операция, которую внёс не владелец, и любое исправление сначала ждут его подтверждения. Проводки до решения нет.
 * Порог — настройка `finance.approve-threshold-usd` (200 $): оценка в долларах считается при вводе операции по
 * курсам на тот момент и лежит в `ledger_operation.amount_usd`.
 */

/** Право подтверждать и отклонять; в наборе ролей оно только у владельца, поэтому у владельца своих «на подтверждении» не бывает. */
export const APPROVE_PERMISSION: Permission = "finance.operation.approve";

export interface ApprovalCheck {
  kind: OperationKind;
  /** оценка размера в долларах, «1234.50»; `null` — курса не было */
  amountUsd: string | null;
  /** у того, кто проводит, есть право подтверждать: его операции проводятся сразу */
  actorCanApprove: boolean;
  thresholdUsd: number;
}

const DECIMAL = /^\d{1,18}(\.\d{1,18})?$/u;

/**
 * Ждёт ли операция владельца. Неизвестное — не мелочь: нет оценки или она не разбирается — ждёт; исправление меняет
 * уже проведённое, поэтому ждёт всегда; остальное — от порога включительно.
 */
export function needsApproval(check: ApprovalCheck): boolean {
  if (check.actorCanApprove) return false;
  if (check.kind === "reversal") return true;
  if (check.amountUsd === null || !DECIMAL.test(check.amountUsd)) return true;
  return Number(check.amountUsd) >= check.thresholdUsd;
}

@Injectable()
export class OperationApprovals {
  private readonly logger = new Logger("ledger-operations");

  constructor(
    private readonly roles: RolesService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly notifier: OperationsNotifier,
  ) {}

  /** Может ли этот человек решать за владельца: право, а не роль — набор ролей меняется без правки кода. */
  async canApprove(actor: AccountRef): Promise<boolean> {
    return await this.roles.can(actor, APPROVE_PERMISSION);
  }

  /** Решать операции на подтверждении может только тот, у кого есть право: маршрут уже проверил, сервис не доверяет. */
  async requireApprover(actor: AccountRef): Promise<void> {
    if (!(await this.canApprove(actor))) throw new ForbiddenError("Подтверждать и отклонять операции учёта может только владелец");
  }

  /** Ждёт ли операция, которую проводит этот человек. Порог читается на момент проведения: правка в панели действует сразу. */
  async required(actor: AccountRef, kind: OperationKind, amountUsd: string | null): Promise<boolean> {
    return needsApproval({
      kind,
      amountUsd,
      actorCanApprove: await this.canApprove(actor),
      thresholdUsd: this.settings.get(SETTINGS.financeApproveThresholdUsd),
    });
  }

  /** Карточка в поток «Бухгалтерия»: не ждём отправки и не падаем от её сбоя. */
  announcePending(card: OperationCard): void {
    this.fire("pending", card.operationId, () => this.notifier.pending(card));
  }

  /** Ответ о решении владельца: так же, без ожидания. */
  announceDecision(card: OperationCard, decision: DecisionNotice): void {
    this.fire("decided", card.operationId, () => this.notifier.decided(card, decision));
  }

  /** Уведомитель сам не бросает, но подмена или будущая правка не должна превратить сбой чата в сбой операции. */
  private fire(event: string, operationId: string, send: () => Promise<void>): void {
    const failed = (error: unknown): void => {
      this.logger.warn(JSON.stringify({ module: "ledger-operations", event: `${event}_unhandled`, operationId, reason: error instanceof Error ? error.message : "unknown" }));
    };
    try {
      send().catch(failed);
    } catch (error: unknown) {
      failed(error);
    }
  }
}
