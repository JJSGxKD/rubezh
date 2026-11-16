import type { MarkOutcome, TelegramAffiliateMark, TelegramAffiliateRepository } from "../../src/modules/attribution/telegram-affiliate.repository.js";

/**
 * Метки партнёрки Telegram в памяти — для тестов слушателя входа и карточки игрока; Prisma-реализацию
 * и общий слот источника проверяет интеграционный тест на живой базе. Занятый слот тест ставит сам:
 * реферера и партнёра в памяти нет.
 */
export class MemoryTelegramAffiliate implements TelegramAffiliateRepository {
  readonly marks = new Map<string, TelegramAffiliateMark>();
  /** кто уже занял слот источника: тест выставляет вручную */
  readonly slots = new Map<string, "referral" | "partner">();
  /** сколько раз звали `mark` — «репозиторий не вызван» проверяется по нулю */
  markCalls = 0;
  /** база недоступна: `mark` и `byAccount` бросают */
  failing = false;

  async mark(input: { accountId: string; startParam: string; ref: string; at: Date }): Promise<MarkOutcome> {
    this.markCalls += 1;
    if (this.failing) throw new Error("база недоступна");
    if (this.marks.has(input.accountId)) return { status: "already" };
    const slot = this.slots.get(input.accountId);
    if (slot !== undefined) return { status: "slot_taken", slot };
    this.marks.set(input.accountId, { startParam: input.startParam, ref: input.ref, markedAt: input.at });
    return { status: "marked" };
  }

  async byAccount(accountId: string): Promise<TelegramAffiliateMark | null> {
    if (this.failing) throw new Error("база недоступна");
    return this.marks.get(accountId) ?? null;
  }
}
