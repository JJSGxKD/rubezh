import { Injectable } from "@nestjs/common";

/**
 * Сверка набора забега — снаряжения и бустов — с тем, что выдал сервер
 * (docs/35-stage4-plan.md §3.4–3.5, Р17).
 *
 * Модуль забегов не знает ни о предметах, ни о бустах: проверки подключают
 * их модули сами, как сверку продолжений — модуль оплаты
 * (`run-continues.ts`). Иначе забегу понадобились бы предметы и бусты, а им —
 * забег, из которого выпадает добыча и на который бусты покупаются.
 */

/** Снимок надетого в том виде, в каком его выдал сервер и вернул клиент. */
export interface SignedLoadout {
  accountId: string;
  modifiers: Record<string, number>;
  issuedAtMs: number;
  signature: string;
}

/**
 * - `none` — забег без снаряжения;
 * - `valid` — снимок подписан сервером для этого игрока и совпадает с
 *   надетым сейчас;
 * - `forged` — подпись не сходится или снимок чужой: честный клиент такого не
 *   пришлёт;
 * - `stale` — снимок настоящий, но надетое с тех пор изменилось. Бывает и у
 *   честного: сменил снаряжение, пока итог ждал сети.
 */
export type LoadoutStatus = "none" | "valid" | "forged" | "stale";

/**
 * - `none` — забег без бустов;
 * - `paid` — каждый заявленный буст куплен на этот забег и не возвращён;
 * - `unpaid` — хоть один не куплен: бусты — только с сетью и с оплатой на
 *   старте, честный клиент без покупки их не применит.
 */
export type BoostStatus = "none" | "paid" | "unpaid";

export interface LoadoutCheck {
  check(accountId: string, snapshot: SignedLoadout): Promise<Exclude<LoadoutStatus, "none">>;
}

export interface BoostCheck {
  check(accountId: string, runId: string, claimed: readonly string[]): Promise<Exclude<BoostStatus, "none">>;
}

@Injectable()
export class RunLoadouts {
  private checker: LoadoutCheck | null = null;
  private boostChecker: BoostCheck | null = null;

  provide(checker: LoadoutCheck): void {
    this.checker = checker;
  }

  provideBoosts(checker: BoostCheck): void {
    this.boostChecker = checker;
  }

  /** Проверки нет — снимку не верим: подписи без ключа не проверить. */
  async check(accountId: string, snapshot: SignedLoadout | undefined): Promise<LoadoutStatus> {
    if (snapshot === undefined) return "none";
    if (this.checker === null) return "forged";
    return await this.checker.check(accountId, snapshot);
  }

  /** Забег без бустов — а таких почти все — к покупкам не ходит. Проверки нет — оплаченным не считается ничего. */
  async checkBoosts(accountId: string, runId: string, claimed: readonly string[]): Promise<BoostStatus> {
    if (claimed.length === 0) return "none";
    if (this.boostChecker === null) return "unpaid";
    return await this.boostChecker.check(accountId, runId, claimed);
  }
}
