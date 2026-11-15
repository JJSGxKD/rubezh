import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";

/**
 * Замок месяца для выплат (docs/37-accounting.md §13, Р222, tasks/T-0469). Выплата читает данные месяца, проверяет
 * правила и пишет проводку несколькими запросами, а снятие закрытия и решение участника меняют те же данные. Без
 * общего замка две выплаты на весь долг проходили бы вместе, а выплата и снятие закрытия разъезжались бы: деньги
 * ушли, а месяц открыт заново. Замок — `pg_advisory_xact_lock` на ключ месяца: общий для всех процессов API,
 * освобождается сам, когда транзакция кончилась, и даже если процесс упал. Транзакция только держит замок; работа идёт
 * по обычным соединениям пула, поэтому замок не вкладывается сам в себя: внутри `run` второй `run` на тот же месяц
 * ждал бы первый вечно.
 */

export interface PayoutLockPort {
  /** Выполнить `work`, пока никто другой не держит замок этого месяца. */
  run<T>(period: string, work: () => Promise<T>): Promise<T>;
}

/** Ожидание соединения для транзакции-замка. */
const LOCK_WAIT_MS = 10_000;
/**
 * Предел всей транзакции — и ожидания чужого замка, и работы под своим: закрытие месяца в базе живёт до сорока секунд,
 * выплата — секунды. Дольше — зависший вызов: транзакция откатится, а замок освободится.
 */
const LOCK_HOLD_MS = 120_000;

@Injectable()
export class PayoutLock implements PayoutLockPort {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async run<T>(period: string, work: () => Promise<T>): Promise<T> {
    return await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger_payouts:${period}`}))`;
        return await work();
      },
      { maxWait: LOCK_WAIT_MS, timeout: LOCK_HOLD_MS },
    );
  }
}
