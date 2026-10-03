import { Injectable, Logger } from "@nestjs/common";

/**
 * Последствия ограничения, которые живут в чужом модуле (docs/35-stage4-plan.md
 * WP44): рейтинг убирает игрока из досок при наложении и возвращает, когда
 * ограничение снято или вышло. Модуль ограничений о них не знает — слушатели
 * подписываются сами, как у `RunsHooks`, и рейтинг не тянет в зависимость
 * модуль, который сам его спрашивает «можно ли».
 */
export interface RestrictionChange {
  accountId: string;
  /** виды наложенных или снятых строк — строкой: запись может быть новее кода */
  kinds: readonly string[];
  at: Date;
}

export type RestrictionListener = (change: RestrictionChange) => Promise<void>;

@Injectable()
export class RestrictionsHooks {
  private readonly logger = new Logger("restrictions");
  private readonly imposedListeners: { name: string; listener: RestrictionListener }[] = [];
  private readonly settledListeners: { name: string; listener: RestrictionListener }[] = [];

  onImposed(name: string, listener: RestrictionListener): void {
    this.imposedListeners.push({ name, listener });
  }

  onSettled(name: string, listener: RestrictionListener): void {
    this.settledListeners.push({ name, listener });
  }

  /**
   * Наложено. Ограничение уже в базе и действует для модулей, которые
   * спрашивают «можно ли», — упавший слушатель его не отменяет, а догоняет
   * свои последствия сам (у рейтинга — обход раз в минуту).
   */
  async emitImposed(change: RestrictionChange): Promise<void> {
    await Promise.all(
      this.imposedListeners.map(async ({ name, listener }) => {
        try {
          await listener(change);
        } catch (error: unknown) {
          this.logger.warn(JSON.stringify({ module: "restrictions", event: "imposed_listener_failed", listener: name, accountId: change.accountId, reason: reasonOf(error) }));
        }
      }),
    );
  }

  /**
   * Снято или вышло. Отказ слушателя — отказ всего снятия последствий:
   * строка не отмечается сведённой, и задача по сроку повторит её через
   * минуту. Иначе игрок, у которого срок вышел, так и не вернулся бы в доски.
   */
  async emitSettled(change: RestrictionChange): Promise<void> {
    const failures: string[] = [];
    await Promise.all(
      this.settledListeners.map(async ({ name, listener }) => {
        try {
          await listener(change);
        } catch (error: unknown) {
          failures.push(`${name}: ${reasonOf(error)}`);
        }
      }),
    );
    if (failures.length > 0) throw new Error(`последствия не сняты — ${failures.join("; ")}`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
