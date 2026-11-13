import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { balances, findEntryProblems, formatMinor, periodOf, reverse as reverseEntry, type EntryDraft, type EntryLine, type LedgerAccount } from "@bh/ledger";
import { z } from "zod";
import { ValidationError } from "../../common/domain-error.js";
import { currencySpec } from "./ledger-currencies.js";
import { decodeCursor, encodeCursor } from "./ledger-cursor.js";
import { LedgerAlreadyReversedError, LedgerEntryInvalidError, LedgerEntryNotFoundError, LedgerSourceConflictError } from "./ledger-errors.js";
import { describeProblem } from "./ledger-problems.js";
import type { AccountBalanceView, JournalEntryView, JournalFilterInput, JournalPage, LedgerMeta } from "./ledger-view.js";
import { LEDGER_REPOSITORY, type LedgerRepository, type StoredLedgerEntry } from "./ledger.repository.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219, tasks/T-0457): запись проводки одной транзакцией с идемпотентностью
 * по ключу источника, сторно, остатки и страницы журнала для панели. Правила проводки — ядро `@bh/ledger`;
 * здесь — то, что без базы не решить: что считать повтором, а что конфликтом.
 */

/** Кто записал проводку; без автора — сервер (проводки из платежей). */
export interface LedgerActor {
  accountId: string;
}

/** Проводка к записи: ядро учёта плюс примечание для разбора. */
export type LedgerPostInput = EntryDraft & { meta?: LedgerMeta | undefined };

export interface PostResult {
  entryId: string;
  /** `false` — проводка с этим ключом и этими строками уже была, вторая не создана */
  created: boolean;
}

/** План счетов меняется редко (новые заводятся из панели), поэтому справочник живёт в памяти процесса минуту. */
const ACCOUNTS_TTL_MS = 60_000;

export const DEFAULT_JOURNAL_LIMIT = 50;
export const MAX_JOURNAL_LIMIT = 100;

/** Длина описания проводки в базе (`memo`, VARCHAR(500)). */
const MAX_MEMO_LENGTH = 500;

/** `meta` приходит из базы как JSON: плоская запись или ничего. Неразборчивое показывать нельзя — `null`. */
const metaSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** Строки проводки без учёта порядка: счёт → сумма. Повтор считается повтором, даже если строки пришли в другом порядке. */
function sameLines(a: readonly EntryLine[], b: readonly EntryLine[]): boolean {
  if (a.length !== b.length) return false;
  const amounts = new Map(a.map((line) => [line.accountId, line.amount]));
  return amounts.size === a.length && b.every((line) => amounts.get(line.accountId) === line.amount);
}

@Injectable()
export class LedgerService {
  private cache: { loadedAt: number; accounts: Map<string, LedgerAccount> } | null = null;

  constructor(@Inject(LEDGER_REPOSITORY) private readonly repository: LedgerRepository) {}

  /**
   * Записать проводку. Повтор с теми же строками отдаёт ту же проводку (`created: false`), повтор с другими —
   * `LedgerSourceConflictError`: тихая перезапись скрыла бы ошибку источника. Описание и время повтора не
   * сравниваются — повторное задание их не обязано помнить.
   */
  async post(input: LedgerPostInput, actor?: LedgerActor): Promise<PostResult> {
    await this.assertValid(input);

    const existing = await this.repository.entryBySource(input.sourceKey);
    if (existing !== null) return this.settle(existing, input);

    const original = input.reversalOf === undefined ? null : await this.repository.entryBySource(input.reversalOf);
    if (input.reversalOf !== undefined && original === null) {
      throw new LedgerEntryInvalidError(`Исходной проводки «${input.reversalOf}» в журнале нет`);
    }

    const entryId = randomUUID();
    const outcome = await this.repository.insertEntry(
      {
        entryId,
        sourceKey: input.sourceKey,
        at: input.at,
        period: periodOf(input.at),
        memo: input.memo,
        reversalOfId: original?.entryId ?? null,
        meta: input.meta ?? null,
        createdBy: actor?.accountId ?? null,
      },
      input.lines,
    );
    if (outcome === "inserted") return { entryId, created: true };
    if (outcome === "already_reversed") throw new LedgerAlreadyReversedError(input.reversalOf ?? input.sourceKey);

    // Ключ заняла другая запись между нашей проверкой и вставкой: читаем победителя и сравниваем с тем же правилом.
    const winner = await this.repository.entryBySource(input.sourceKey);
    if (winner === null) throw new Error(`Ключ источника «${input.sourceKey}» занят, но проводки с ним в журнале нет`);
    return this.settle(winner, input);
  }

  /**
   * Сторно: обратные знаки всех строк и ссылка на исходную. Исправление журнала — только так; повтор с тем же
   * `newSourceKey` — та же проводка, второе сторно исходной под другим ключом — `LedgerAlreadyReversedError`.
   */
  async reverse(sourceKey: string, newSourceKey: string, at: Date, memo: string, actor?: LedgerActor): Promise<PostResult> {
    const original = await this.repository.entryBySource(sourceKey);
    if (original === null) throw new LedgerEntryNotFoundError(sourceKey);
    const draft = reverseEntry({ sourceKey: original.sourceKey, at: original.at, memo: original.memo, lines: original.lines }, newSourceKey, at, memo);
    return await this.post(draft, actor);
  }

  /**
   * Сбросить справочник счетов в памяти процесса: счёт завели или переименовали (места и статьи учёта, Р220).
   * Другие процессы узнают о нём через минуту или при первой проводке по неизвестному счёту.
   */
  forgetAccounts(): void {
    this.cache = null;
  }

  /** Остатки всех счетов плана по нормальной стороне; счёт без проводок — с нулём. */
  async balances(): Promise<AccountBalanceView[]> {
    // Справочник читается заново: панель не должна минуту не видеть счёт, который только что завели.
    const accounts = await this.accounts(true);
    const sums = await this.repository.balances();
    const result = balances([...sums].map(([accountId, amount]) => ({ accountId, amount })), accounts);
    return [...accounts.values()].map((account) => ({
      accountId: account.id,
      name: account.name,
      type: account.type,
      currency: account.currency,
      balance: formatMinor(result.get(account.id) ?? 0n, currencySpec(account.currency)),
    }));
  }

  /** Страница журнала: новые сверху, суммы строками; `next` — курсор следующей страницы или `null`. */
  async journal(filter: JournalFilterInput, cursor: string | null, limit: number = DEFAULT_JOURNAL_LIMIT): Promise<JournalPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOURNAL_LIMIT) {
      throw new ValidationError(`Страница журнала — от 1 до ${String(MAX_JOURNAL_LIMIT)} проводок`);
    }
    const position = cursor === null ? null : decodeCursor(cursor);
    // Одна лишняя проводка говорит, есть ли следующая страница, и не требует отдельного запроса «сколько всего».
    const rows = await this.repository.journal(filter, position, limit + 1);
    const page = rows.slice(0, limit);
    const accounts = await this.accountsFor(page);
    const last = page.at(-1);
    return {
      entries: page.map((row) => this.view(row, accounts)),
      next: rows.length > limit && last !== undefined ? encodeCursor({ at: last.at, entryId: last.entryId }) : null,
    };
  }

  /** Всё, что мешает записать проводку: правила ядра, потом то, что знает база (длина описания, дата). */
  private async assertValid(input: LedgerPostInput): Promise<void> {
    let accounts = await this.accounts();
    let problems = findEntryProblems(input, accounts);
    // Счёт могли завести после последнего чтения справочника: перед отказом перечитываем его один раз.
    if (problems.some((problem) => problem.kind === "unknown_account")) {
      accounts = await this.accounts(true);
      problems = findEntryProblems(input, accounts);
    }
    const first = problems[0];
    if (first !== undefined) throw new LedgerEntryInvalidError(describeProblem(first));
    if (Number.isNaN(input.at.getTime())) throw new LedgerEntryInvalidError("Дата проводки не определена");
    if (input.memo.length > MAX_MEMO_LENGTH) throw new LedgerEntryInvalidError(`Описание проводки длиннее ${String(MAX_MEMO_LENGTH)} знаков`);
  }

  /** Проводка с этим ключом уже есть: повтор — если строки и ссылка на исходную те же, иначе конфликт. */
  private settle(existing: StoredLedgerEntry, input: LedgerPostInput): PostResult {
    if (!sameLines(existing.lines, input.lines) || existing.reversalOf !== (input.reversalOf ?? null)) {
      throw new LedgerSourceConflictError(input.sourceKey);
    }
    return { entryId: existing.entryId, created: false };
  }

  private async accounts(refresh = false): Promise<Map<string, LedgerAccount>> {
    const now = Date.now();
    if (!refresh && this.cache !== null && now - this.cache.loadedAt < ACCOUNTS_TTL_MS) return this.cache.accounts;
    const rows = await this.repository.accounts();
    const accounts = new Map<string, LedgerAccount>(rows.map((row) => [row.accountId, { id: row.accountId, type: row.type, currency: row.currency, name: row.name }]));
    this.cache = { loadedAt: now, accounts };
    return accounts;
  }

  /** Справочник для строк страницы: счёт, которого нет в кэше, — повод перечитать его один раз. */
  private async accountsFor(entries: readonly StoredLedgerEntry[]): Promise<Map<string, LedgerAccount>> {
    const accounts = await this.accounts();
    const missing = entries.some((entry) => entry.lines.some((line) => !accounts.has(line.accountId)));
    return missing ? await this.accounts(true) : accounts;
  }

  private view(row: StoredLedgerEntry, accounts: ReadonlyMap<string, LedgerAccount>): JournalEntryView {
    const parsedMeta = row.meta === null || row.meta === undefined ? null : metaSchema.safeParse(row.meta);
    return {
      entryId: row.entryId,
      sourceKey: row.sourceKey,
      at: row.at.toISOString(),
      period: row.period,
      memo: row.memo,
      reversalOf: row.reversalOf,
      createdBy: row.createdBy,
      meta: parsedMeta !== null && parsedMeta.success ? parsedMeta.data : null,
      lines: row.lines.map((line) => {
        const account = accounts.get(line.accountId);
        // Строка по неизвестному счёту — повреждённый журнал; показать её с выдуманной валютой значило бы соврать.
        if (account === undefined) throw new Error(`В журнале строка по неизвестному счёту «${line.accountId}»`);
        return { accountId: account.id, accountName: account.name, currency: account.currency, amount: formatMinor(line.amount, currencySpec(account.currency)) };
      }),
    };
  }
}
