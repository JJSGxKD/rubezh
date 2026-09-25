import { Injectable } from "@nestjs/common";

/**
 * Сверка вторых шансов забега с покупками (docs/34-stage3-plan.md, WP5).
 *
 * Модуль забегов о платежах не знает: сверку подключает модуль оплаты сам,
 * как слушатели подписываются на записанный забег (`runs-hooks.ts`). Иначе
 * модули зависели бы друг от друга по кругу — оплате нужен забег, который
 * продолжают, а забегу — оплата его продолжений.
 */

export interface ContinueCheck {
  /** сколько продолжений забега оплачено */
  paid: number;
  /** за продолжение заплачено по меньшему числу минут, чем прошло на самом деле (Р5.2) */
  underpaid: boolean;
}

export interface ContinueLedger {
  check(runId: string, continues: readonly number[]): Promise<ContinueCheck>;
}

const NOTHING_PAID: ContinueCheck = { paid: 0, underpaid: false };

@Injectable()
export class RunContinues {
  private ledger: ContinueLedger | null = null;

  provide(ledger: ContinueLedger): void {
    this.ledger = ledger;
  }

  /**
   * Забег без продолжений — а их почти все — в базу за покупками не ходит.
   * Сверки нет — оплаченным не считается ничего: продолжение без покупки
   * взять неоткуда, кроме подделанного клиента.
   */
  async check(runId: string, continues: readonly number[]): Promise<ContinueCheck> {
    if (continues.length === 0 || this.ledger === null) return NOTHING_PAID;
    return await this.ledger.check(runId, continues);
  }
}
