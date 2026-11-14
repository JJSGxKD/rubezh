import { Injectable } from "@nestjs/common";

/**
 * Что месяцу учёта нужно от выплат и подтверждений (Р222, tasks/T-0468; их строит T-0469): снять закрытие можно,
 * пока по месяцу не было ни одной выплаты, а снятие сбрасывает подтверждения участников. Пока выплат нет вовсе,
 * хуки по умолчанию ничего не знают и ничего не делают — закрытие снимается всегда.
 */
export interface PeriodHooks {
  /** по месяцу была хотя бы одна выплата: закрытие снять нельзя */
  hasPayouts(period: string): Promise<boolean>;
  /** закрытие снято: подтверждения участников месяца недействительны */
  resetConfirmations(period: string): Promise<void>;
}

export const PERIOD_HOOKS = Symbol("PERIOD_HOOKS");

@Injectable()
export class NoPeriodHooks implements PeriodHooks {
  async hasPayouts(): Promise<boolean> {
    return false;
  }

  async resetConfirmations(): Promise<void> {}
}
