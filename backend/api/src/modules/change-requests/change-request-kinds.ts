import type { Permission } from "../roles/permissions.js";
import { ChangeRequestUnsupportedKindError } from "./change-request-errors.js";
import type { ChangeKind, ChangeRequestRow, ChangeTargetView, ChangeTx, JsonValue } from "./change-request-types.js";

export type { ChangeTargetView } from "./change-request-types.js";

/**
 * Вид правки (docs/19-content-admin.md §6, tasks/T-0309): что именно меняет
 * заявка и по каким правилам. Механизм заявок — срок, подтверждение другим,
 * гашение прежней, условие «цель всё ещё равна было» — общий; вид даёт только
 * цель: как её прочитать, проверить и записать. Цены товаров — `SkuPriceKind`,
 * числа наград — `RewardSettingKind` (T-0310).
 */
export interface ChangeKindHandler {
  readonly kind: ChangeKind;
  /** право подавать и подтверждать заявки этого вида; решает другой человек с тем же правом */
  readonly permission: Permission;
  /**
   * Что предлагается: «было» берётся из цели сейчас, из заявки убирается то,
   * что не меняется. Форма, пределы и неизвестная цель — отказ; заявка не заводится.
   */
  prepare(tx: ChangeTx, target: string, after: unknown): Promise<{ before: JsonValue; after: JsonValue }>;
  /** Состояние цели сейчас в тех же полях, что и `before`: совпало — заявку можно применять. */
  current(tx: ChangeTx, request: ChangeRequestRow): Promise<JsonValue>;
  /** Записать правку в той же транзакции, что и подтверждение. */
  apply(tx: ChangeTx, request: ChangeRequestRow, by: string, at: Date): Promise<void>;
  /** После фиксации транзакции: то, что она откатить не может, например кэш реплики. Сбой решения не отменяет. */
  afterCommit(request: ChangeRequestRow): void | Promise<void>;
  /** Предупреждения к заявке для того, кто её решает: правка допустима, но на что-то стоит взглянуть. */
  warnings?(request: ChangeRequestRow): string[];
  /** Цели правки для панели с их значениями сейчас и в коде. */
  targets(): Promise<ChangeTargetView[]>;
  /** Строка для чата и журнала: что меняется, словами. */
  describe(request: ChangeRequestRow): string;
}

/** Виды правок, которые умеет сервис; незнакомый вид — отказ, а не заявка в никуда. */
export class ChangeKindRegistry {
  private readonly byKind: ReadonlyMap<ChangeKind, ChangeKindHandler>;

  constructor(handlers: readonly ChangeKindHandler[]) {
    this.byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
  }

  get(kind: ChangeKind): ChangeKindHandler {
    const handler = this.byKind.get(kind);
    if (handler === undefined) throw new ChangeRequestUnsupportedKindError();
    return handler;
  }

  all(): readonly ChangeKindHandler[] {
    return [...this.byKind.values()];
  }
}
