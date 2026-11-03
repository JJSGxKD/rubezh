import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { admitMode, prologueGrantKey, prologueRewardLines, requireSectionsOpen, sectionsOpen } from "./prologue-rules.js";
import type { Difficulty, RunMode } from "./run-rules.js";

/**
 * Пролог на сервере (tasks/T-0279, docs/35-stage4-plan.md Р151): признак «пролог
 * пройден», награда за победу и закрытые до неё разделы. Правила — в
 * `prologue-rules.ts`, здесь только база и кошелёк.
 *
 * **Награда — один раз на аккаунт.** Ключ начисления собирается из аккаунта, а не
 * из забега (`prologue:<аккаунт>`): два запроса разом и два разных забега-пролога
 * дают одну строку журнала на ресурс. Начисление идёт **раньше** отметки: упали
 * между ними — признак пуст, игрок пройдёт пролог ещё раз, а повторное
 * начисление кошелёк узнает по ключу и не удвоит. Наоборот награда была бы
 * потеряна: отметка без начисления никого уже не позовёт.
 */

const DB_TIMEOUT_MS = 3_000;

export const PROLOGUE_STORE = Symbol("PROLOGUE_STORE");

export interface PrologueStore {
  /** когда пройден пролог; `null` — не пройден, неизвестный аккаунт тоже */
  doneAt(accountId: string): Promise<Date | null>;
  /** поставить признак, если он пуст; `false` — уже стоял (второй запрос или миграция) */
  markDone(accountId: string, at: Date): Promise<boolean>;
}

@Injectable()
export class PrismaPrologueStore implements PrologueStore {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async doneAt(accountId: string): Promise<Date | null> {
    const row = await this.prisma.account.findUnique({ where: { accountId }, select: { prologueDoneAt: true } });
    return row?.prologueDoneAt ?? null;
  }

  async markDone(accountId: string, at: Date): Promise<boolean> {
    // Условие в самом обновлении: из двух одновременных побед признак ставит ровно одна.
    const updated = await this.prisma.account.updateMany({ where: { accountId, prologueDoneAt: null }, data: { prologueDoneAt: at } });
    return updated.count === 1;
  }
}

export interface PrologueSettlement {
  accountId: string;
  /** по часам сервера */
  at: Date;
  /** секунда победы со слов итога — для лога */
  sec?: number;
}

@Injectable()
export class PrologueService {
  private readonly logger = new Logger("prologue");

  constructor(
    @Inject(PROLOGUE_STORE) private readonly store: PrologueStore,
    private readonly wallet: WalletService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async doneAt(accountId: string): Promise<Date | null> {
    return await withTimeout(this.store.doneAt(accountId), DB_TIMEOUT_MS, "признак пролога");
  }

  async isDone(accountId: string): Promise<boolean> {
    return sectionsOpen(await this.doneAt(accountId));
  }

  /** «Награда дня» и «Задания»: до победы в прологе — 409 `prologue_required`. */
  async requireOpen(accountId: string): Promise<void> {
    requireSectionsOpen(await this.doneAt(accountId));
  }

  /** Режим, которым записать забег (`prologue-rules.ts` → `admitMode`). */
  async admit(accountId: string, mode: RunMode | undefined, difficulty: Difficulty): Promise<RunMode> {
    // Признак нужен только прологу: обычный забег лишнего запроса в базу не делает.
    const doneAt = mode === "prologue" ? await this.doneAt(accountId) : null;
    return admitMode({ mode, difficulty, doneAt });
  }

  /**
   * Победа в прологе принята: начислить награду и поставить признак. Повтор
   * безопасен — вызывается и после сбоя посередине, и двумя запросами разом.
   */
  async settle(settlement: PrologueSettlement): Promise<{ first: boolean }> {
    const { accountId, at } = settlement;
    const lines = prologueRewardLines(this.settings.get(SETTINGS.prologueRewardCoins), this.settings.get(SETTINGS.prologueRewardGems));
    for (const line of lines) {
      await this.wallet.grant({
        accountId,
        resource: line.resource,
        amount: line.amount,
        reason: "prologue_reward",
        source: "prologue",
        idempotencyKey: prologueGrantKey(accountId, line.resource),
        at,
      });
    }
    const first = await withTimeout(this.store.markDone(accountId, at), DB_TIMEOUT_MS, "признак пролога");
    if (first) this.logger.log(JSON.stringify({ module: "prologue", event: "prologue_won", accountId, sec: settlement.sec ?? null }));
    return { first };
  }
}
