import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { StakeholderSharesOverError } from "./stakeholder-errors.js";
import { monthKey, parseMonth, type OverLimit, type ShareRecord } from "./stakeholder-rules.js";

/**
 * Доли участников проекта в базе (`stakeholder_share`, docs/35-stage4-plan.md Р217, tasks/T-0452). Строк
 * столько, сколько раз владелец менял доли: участников единицы, правок единицы в месяц, — поэтому чтение
 * без страниц и лимита: таблица руками владельца не вырастет.
 */

/** Строка доли, как её читает панель: с именами участника и того, кто менял. */
export interface StoredShare extends ShareRecord {
  note: string;
  /** аккаунт, который назначил долю */
  setBy: string;
  setByName: string;
  setAt: Date;
}

/** Участник для списка: аккаунт с ролью или хотя бы с одной строкой доли. */
export interface ParticipantRow {
  accountId: string;
  displayName: string;
  /** роль «Участник проекта» на аккаунте сейчас: снятие роли доли не стирает */
  hasRole: boolean;
}

export interface SetShareInput {
  accountId: string;
  /** `ГГГГ-ММ` */
  fromMonth: string;
  shareBp: number;
  note: string;
  setBy: string;
  at: Date;
}

/** Что было на этом месяце до записи (`null` — записи не было) и что стало. */
export interface SetShareResult {
  before: { fromMonth: string; shareBp: number } | null;
  after: { fromMonth: string; shareBp: number };
}

/** Проверка предела суммы — передаётся репозиторию, чтобы она шла под блокировкой, с теми же строками, что и запись. */
export type ShareCheck = (all: readonly ShareRecord[], change: ShareRecord) => OverLimit | null;

export const STAKEHOLDERS_REPOSITORY = Symbol("STAKEHOLDERS_REPOSITORY");

export interface StakeholdersRepository {
  /** Все строки долей с именами. */
  history(): Promise<StoredShare[]>;
  /** Аккаунты с ролью участника или с долей. */
  participants(): Promise<ParticipantRow[]>;
  /** Один аккаунт для проверки перед записью; `null` — аккаунта нет. */
  account(accountId: string): Promise<ParticipantRow | null>;
  /**
   * Записать долю на месяц: заменить запись того же аккаунта и месяца или добавить. Предел суммы
   * проверяется внутри, под блокировкой; превышение — `StakeholderSharesOverError`, и ничего не пишется.
   */
  setShare(input: SetShareInput, check: ShareCheck): Promise<SetShareResult>;
}

/** Ключ блокировки таблицы долей: два запроса разом иначе проверили бы сумму каждый по старым строкам. */
const SHARES_LOCK = "stakeholder_share";

@Injectable()
export class PrismaStakeholdersRepository implements StakeholdersRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async history(): Promise<StoredShare[]> {
    const rows = await this.prisma.stakeholderShare.findMany({
      include: { setter: { select: { displayName: true } } },
      orderBy: [{ fromMonth: "desc" }, { setAt: "desc" }],
    });
    return rows.map((row) => ({
      accountId: row.accountId,
      fromMonth: monthKey(row.fromMonth),
      shareBp: row.shareBp,
      note: row.note,
      setBy: row.setBy,
      setByName: row.setter.displayName,
      setAt: row.setAt,
    }));
  }

  async participants(): Promise<ParticipantRow[]> {
    const rows = await this.prisma.account.findMany({
      where: { OR: [{ roles: { some: { role: "stakeholder" } } }, { sharesHeld: { some: {} } }] },
      select: { accountId: true, displayName: true, roles: { where: { role: "stakeholder" }, select: { role: true } } },
    });
    return rows.map((row) => ({ accountId: row.accountId, displayName: row.displayName, hasRole: row.roles.length > 0 }));
  }

  async account(accountId: string): Promise<ParticipantRow | null> {
    const row = await this.prisma.account.findUnique({
      where: { accountId },
      select: { accountId: true, displayName: true, roles: { where: { role: "stakeholder" }, select: { role: true } } },
    });
    return row === null ? null : { accountId: row.accountId, displayName: row.displayName, hasRole: row.roles.length > 0 };
  }

  async setShare(input: SetShareInput, check: ShareCheck): Promise<SetShareResult> {
    const month = parseMonth(input.fromMonth);
    return await this.prisma.$transaction(async (tx) => {
      // Две вкладки владельца разом не обойдут предел: вторая ждёт первую и читает уже записанное.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SHARES_LOCK}))`;
      const rows = await tx.stakeholderShare.findMany({ select: { accountId: true, fromMonth: true, shareBp: true } });
      const all: ShareRecord[] = rows.map((row) => ({ accountId: row.accountId, fromMonth: monthKey(row.fromMonth), shareBp: row.shareBp }));

      const over = check(all, { accountId: input.accountId, fromMonth: input.fromMonth, shareBp: input.shareBp });
      if (over !== null) throw new StakeholderSharesOverError(over.month, over.totalBp);

      const previous = all.find((row) => row.accountId === input.accountId && row.fromMonth === input.fromMonth) ?? null;
      await tx.stakeholderShare.upsert({
        where: { accountId_fromMonth: { accountId: input.accountId, fromMonth: month } },
        create: { shareId: randomUUID(), accountId: input.accountId, fromMonth: month, shareBp: input.shareBp, note: input.note, setBy: input.setBy, setAt: input.at },
        update: { shareBp: input.shareBp, note: input.note, setBy: input.setBy, setAt: input.at },
      });
      return {
        before: previous === null ? null : { fromMonth: previous.fromMonth, shareBp: previous.shareBp },
        after: { fromMonth: input.fromMonth, shareBp: input.shareBp },
      };
    });
  }
}
