import { Injectable } from "@nestjs/common";
import type { GrantReason } from "./wallet-types.js";

/**
 * Надбавки к начислению по причине (docs/35-stage4-plan.md §3.14, Р44):
 * VIP получает награды дня, колеса, забега и заданий больше. Надбавка
 * применяется в одном месте — в начислении кошелька, — а не в каждом модуле,
 * который награждает: иначе рано или поздно один из них её забудет.
 *
 * Кошелёк о VIP не знает: тот, кто даёт надбавку, регистрирует её здесь сам
 * — тот же приём, что у выдачи покупок. Суточный потолок причины растёт на
 * ту же надбавку, но не снимается (Р44).
 */
export type BonusProvider = (accountId: string, reason: GrantReason, at: Date) => Promise<number>;

@Injectable()
export class WalletBonuses {
  private readonly providers: { name: string; provider: BonusProvider }[] = [];

  register(name: string, provider: BonusProvider): void {
    this.providers.push({ name, provider });
  }

  /**
   * Множитель начисления: произведение надбавок, не меньше единицы. Упавшая
   * надбавка роняет начисление — повтор с тем же ключом начислит заново, а
   * начисленное без надбавки ключом уже не исправить.
   */
  async multiplier(accountId: string, reason: GrantReason, at: Date): Promise<number> {
    let result = 1;
    for (const { name, provider } of this.providers) {
      const value = await provider(accountId, reason, at);
      if (!Number.isFinite(value) || value < 1) throw new Error(`надбавка ${name} вернула ${String(value)} — ожидается число не меньше единицы`);
      result *= value;
    }
    return result;
  }
}
