import { Injectable } from "@nestjs/common";

/**
 * Сверка вторых шансов забега с тем, чем за них заплачено
 * (docs/34-stage3-plan.md, WP5; docs/35-stage4-plan.md WP11): покупками за
 * звёзды и рекламой.
 *
 * Модуль забегов о платежах не знает: книгу покупок подключает модуль оплаты
 * сам, как слушатели подписываются на записанный забег (`runs-hooks.ts`).
 * Иначе модули зависели бы друг от друга по кругу — оплате нужен забег,
 * который продолжают, а забегу — оплата его продолжений. Книгу рекламных
 * продолжений подключает их хозяин в этом же модуле.
 */

export interface ContinueCheck {
  /** сколько продолжений забега оплачено */
  paid: number;
  /** за продолжение заплачено по меньшему числу минут, чем прошло на самом деле (Р5.2) */
  underpaid: boolean;
}

export interface ContinueLedger {
  check(runId: string, continues: readonly number[]): Promise<ContinueCheck>;
  /** номера продолжений забега, уже выданных этим способом */
  granted(runId: string): Promise<number[]>;
}

const NOTHING_PAID: ContinueCheck = { paid: 0, underpaid: false };

@Injectable()
export class RunContinues {
  private readonly ledgers: ContinueLedger[] = [];

  provide(ledger: ContinueLedger): void {
    this.ledgers.push(ledger);
  }

  /**
   * Забег без продолжений — а их почти все — в базу за покупками не ходит.
   * Книг нет — оплаченным не считается ничего: продолжение без покупки
   * взять неоткуда, кроме подделанного клиента.
   */
  async check(runId: string, continues: readonly number[]): Promise<ContinueCheck> {
    if (continues.length === 0 || this.ledgers.length === 0) return NOTHING_PAID;
    const checks = await Promise.all(this.ledgers.map((ledger) => ledger.check(runId, continues)));
    return { paid: checks.reduce((sum, check) => sum + check.paid, 0), underpaid: checks.some((check) => check.underpaid) };
  }

  /**
   * Номера продолжений забега, уже выданных любым способом: тот же номер
   * вторым способом не выдаётся — иначе игрок заплатил бы дважды за одно.
   */
  async taken(runId: string): Promise<Set<number>> {
    const granted = await Promise.all(this.ledgers.map((ledger) => ledger.granted(runId)));
    return new Set(granted.flat());
  }
}
