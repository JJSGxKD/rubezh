import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Вехи воронки аккаунта (docs/35-stage4-plan.md, Р30, §3.10). Каждая веха —
 * дата первого раза: одна вставка с `ON CONFLICT` и `COALESCE`, поэтому
 * повторное событие ничего не двигает, а параллельные сходятся в базе.
 * Выражения `SET` видят строку до обновления — на этом держатся счётчик
 * забегов и возвраты по суткам.
 */

/** Граница суток — по Москве, как у всех суточных механик (`05-game-design.md` §3). */
export const FUNNEL_TIME_ZONE = "Europe/Moscow";

export const FUNNEL_REPOSITORY = Symbol("FUNNEL_REPOSITORY");

export interface FunnelRepository {
  /** вошёл в канал площадки: бот, сообщество, страница */
  entered(accountId: string, at: Date): Promise<void>;
  /** запуск приложения: первый — полная регистрация, следующие — возвраты на D1 и D7 */
  appOpened(accountId: string, at: Date): Promise<void>;
  firstRunStarted(accountId: string, at: Date): Promise<void>;
  /** забег записан — первый и счётчик для вех второго и пятого */
  runRecorded(accountId: string, at: Date): Promise<void>;
  firstPurchase(accountId: string, at: Date): Promise<void>;
}

@Injectable()
export class PrismaFunnelRepository implements FunnelRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async entered(accountId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO account_funnel (account_id, entered_at) VALUES (${accountId}::uuid, ${at})
      ON CONFLICT (account_id) DO UPDATE SET entered_at = COALESCE(account_funnel.entered_at, EXCLUDED.entered_at)
    `;
  }

  async appOpened(accountId: string, at: Date): Promise<void> {
    // Возврат считается от первого открытия: запуск на следующие сутки и
    // позже — D1, на седьмые и позже — D7 (удержание «скользящее»; точное по
    // дням — из сессий). У первого запуска прежнего открытия нет, и возвратов
    // он не ставит.
    await this.prisma.$executeRaw`
      INSERT INTO account_funnel (account_id, app_opened_at) VALUES (${accountId}::uuid, ${at})
      ON CONFLICT (account_id) DO UPDATE SET
        app_opened_at = COALESCE(account_funnel.app_opened_at, EXCLUDED.app_opened_at),
        returned_d1_at = COALESCE(account_funnel.returned_d1_at, CASE
          WHEN account_funnel.app_opened_at IS NOT NULL
            AND (EXCLUDED.app_opened_at AT TIME ZONE ${FUNNEL_TIME_ZONE})::date >= (account_funnel.app_opened_at AT TIME ZONE ${FUNNEL_TIME_ZONE})::date + 1
          THEN EXCLUDED.app_opened_at END),
        returned_d7_at = COALESCE(account_funnel.returned_d7_at, CASE
          WHEN account_funnel.app_opened_at IS NOT NULL
            AND (EXCLUDED.app_opened_at AT TIME ZONE ${FUNNEL_TIME_ZONE})::date >= (account_funnel.app_opened_at AT TIME ZONE ${FUNNEL_TIME_ZONE})::date + 7
          THEN EXCLUDED.app_opened_at END)
    `;
  }

  async firstRunStarted(accountId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO account_funnel (account_id, first_run_started_at) VALUES (${accountId}::uuid, ${at})
      ON CONFLICT (account_id) DO UPDATE SET first_run_started_at = COALESCE(account_funnel.first_run_started_at, EXCLUDED.first_run_started_at)
    `;
  }

  async runRecorded(accountId: string, at: Date): Promise<void> {
    // Слушатели записанного забега зовутся один раз на забег, поэтому
    // счётчик — это число забегов, а не повторов итога.
    await this.prisma.$executeRaw`
      INSERT INTO account_funnel (account_id, first_run_finished_at, runs_recorded) VALUES (${accountId}::uuid, ${at}, 1)
      ON CONFLICT (account_id) DO UPDATE SET
        first_run_finished_at = COALESCE(account_funnel.first_run_finished_at, EXCLUDED.first_run_finished_at),
        runs_recorded = account_funnel.runs_recorded + 1,
        runs_2_at = COALESCE(account_funnel.runs_2_at, CASE WHEN account_funnel.runs_recorded + 1 >= 2 THEN EXCLUDED.first_run_finished_at END),
        runs_5_at = COALESCE(account_funnel.runs_5_at, CASE WHEN account_funnel.runs_recorded + 1 >= 5 THEN EXCLUDED.first_run_finished_at END)
    `;
  }

  async firstPurchase(accountId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO account_funnel (account_id, first_purchase_at) VALUES (${accountId}::uuid, ${at})
      ON CONFLICT (account_id) DO UPDATE SET first_purchase_at = COALESCE(account_funnel.first_purchase_at, EXCLUDED.first_purchase_at)
    `;
  }
}
