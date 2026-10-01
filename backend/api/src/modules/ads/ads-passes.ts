import { Injectable } from "@nestjs/common";

/**
 * Реклама без ролика (docs/35-stage4-plan.md §3.6, Р44): пока VIP идёт,
 * награда места выдаётся сразу, а межстраничной нет вовсе. Кулдаун места
 * остаётся: VIP пропускает ролик, а не паузу между наградами.
 *
 * Модуль рекламы о VIP не знает: тот, кто даёт пропуск, регистрирует его
 * здесь сам — тот же приём, что у надбавок кошелька (`wallet/wallet-bonus.ts`).
 */
export type AdPassCheck = (accountId: string, at: Date) => Promise<boolean>;

/** Имя пропуска пишется в сессию вместо сети: по нему воронка в панели отличает награды без ролика. */
const PASS_NAME = /^[a-z][a-z0-9_]{1,31}$/;

@Injectable()
export class AdPasses {
  private readonly checks: { name: string; check: AdPassCheck }[] = [];

  register(name: string, check: AdPassCheck): void {
    if (!PASS_NAME.test(name)) throw new Error(`имя пропуска рекламы «${name}» — строчная латиница, цифры и подчёркивание, до 32 знаков`);
    this.checks.push({ name, check });
  }

  /** Первый пропуск, который у игрока есть сейчас; `null` — игрок смотрит рекламу. */
  async of(accountId: string, at: Date): Promise<string | null> {
    for (const { name, check } of this.checks) if (await check(accountId, at)) return name;
    return null;
  }
}
