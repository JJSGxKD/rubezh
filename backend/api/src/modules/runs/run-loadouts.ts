import { Injectable } from "@nestjs/common";

/**
 * Сверка снаряжения забега с подписанным снимком (docs/35-stage4-plan.md
 * §3.4, WP7, Р17).
 *
 * Модуль забегов о предметах не знает: проверку подключает модуль
 * снаряжения сам, как сверку продолжений — модуль оплаты
 * (`run-continues.ts`). Иначе забегу понадобились бы предметы, а предметам —
 * забег, из которого выпадает добыча.
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

export interface LoadoutCheck {
  check(accountId: string, snapshot: SignedLoadout): Promise<Exclude<LoadoutStatus, "none">>;
}

@Injectable()
export class RunLoadouts {
  private checker: LoadoutCheck | null = null;

  provide(checker: LoadoutCheck): void {
    this.checker = checker;
  }

  /** Проверки нет — снимку не верим: подписи без ключа не проверить. */
  async check(accountId: string, snapshot: SignedLoadout | undefined): Promise<LoadoutStatus> {
    if (snapshot === undefined) return "none";
    if (this.checker === null) return "forged";
    return await this.checker.check(accountId, snapshot);
  }
}
