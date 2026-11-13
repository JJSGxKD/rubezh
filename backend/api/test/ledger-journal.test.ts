import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import {
  LedgerAlreadyReversedError,
  LedgerCursorInvalidError,
  LedgerEntryInvalidError,
  LedgerEntryNotFoundError,
  LedgerSourceConflictError,
} from "../src/modules/ledger/ledger-errors.js";
import type {
  InsertResult,
  JournalCursor,
  JournalFilter,
  LedgerRepository,
  NewLedgerEntry,
  StoredLedgerAccount,
  StoredLedgerEntry,
  StoredLedgerLine,
} from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";

/**
 * Журнал учёта: сервис на подменённом репозитории (Р219, tasks/T-0457). Ядро учёта проверяет проводку, сервис —
 * идемпотентность по ключу источника, сторно, остатки и страницы журнала; запись в базе, гонку и триггер
 * проверяет интеграционный тест.
 */

const AT = new Date("2026-11-13T12:00:00Z");

/** Начальный план счетов (Р219) — как в миграции, в порядке вставки. */
const PLAN: StoredLedgerAccount[] = [
  { accountId: "stars.bot.hold", type: "asset", currency: "XTR", name: "Звёзды бота — в холде", archivedAt: null },
  { accountId: "stars.bot.available", type: "asset", currency: "XTR", name: "Звёзды бота — доступно", archivedAt: null },
  { accountId: "wallet.ton", type: "asset", currency: "GRAM", name: "Кошелёк TON", archivedAt: null },
  { accountId: "bank.rub", type: "asset", currency: "RUB", name: "Банк, ₽", archivedAt: null },
  { accountId: "revenue.shop.telegram", type: "revenue", currency: "XTR", name: "Выручка: магазин, Telegram", archivedAt: null },
  { accountId: "revenue.vip.telegram", type: "revenue", currency: "XTR", name: "Выручка: VIP, Telegram", archivedAt: null },
];

/** Репозиторий в памяти с теми же правилами, что у базы: уникален ключ источника и «сторно — не больше одного». */
class MemoryLedgerRepository implements LedgerRepository {
  accountRows: StoredLedgerAccount[] = [...PLAN];
  readonly entries: StoredLedgerEntry[] = [];
  accountReads = 0;
  /** сколько раз сервис спрашивал проводку по ключу — для гонки */
  sourceReads = 0;
  /** гонка: перед вставкой «другой писатель» успевает записать проводку с тем же ключом */
  rival: (() => void) | null = null;

  async accounts(): Promise<StoredLedgerAccount[]> {
    this.accountReads += 1;
    return this.accountRows.map((row) => ({ ...row }));
  }

  async entryBySource(sourceKey: string): Promise<StoredLedgerEntry | null> {
    this.sourceReads += 1;
    const found = this.entries.find((entry) => entry.sourceKey === sourceKey);
    return found === undefined ? null : { ...found, lines: found.lines.map((line) => ({ ...line })) };
  }

  async insertEntry(entry: NewLedgerEntry, lines: readonly StoredLedgerLine[]): Promise<InsertResult> {
    if (this.rival !== null) {
      const rival = this.rival;
      this.rival = null;
      rival();
    }
    if (this.entries.some((existing) => existing.sourceKey === entry.sourceKey)) return "source_taken";
    const original = entry.reversalOfId === null ? null : (this.entries.find((existing) => existing.entryId === entry.reversalOfId) ?? null);
    if (entry.reversalOfId !== null && this.entries.some((existing) => existing.reversalOf === original?.sourceKey)) return "already_reversed";
    this.entries.push({
      entryId: entry.entryId,
      sourceKey: entry.sourceKey,
      at: entry.at,
      period: entry.period,
      memo: entry.memo,
      reversalOf: original?.sourceKey ?? null,
      meta: entry.meta,
      createdBy: entry.createdBy,
      createdAt: new Date(),
      lines: lines.map((line) => ({ ...line })),
    });
    return "inserted";
  }

  async balances(): Promise<Map<string, bigint>> {
    const sums = new Map<string, bigint>();
    for (const entry of this.entries) {
      for (const line of entry.lines) sums.set(line.accountId, (sums.get(line.accountId) ?? 0n) + line.amount);
    }
    return sums;
  }

  async journal(filter: JournalFilter, cursor: JournalCursor | null, limit: number): Promise<StoredLedgerEntry[]> {
    const currencyOf = new Map(this.accountRows.map((row) => [row.accountId, row.currency]));
    return this.entries
      .filter((entry) => filter.accountId === undefined || entry.lines.some((line) => line.accountId === filter.accountId))
      .filter((entry) => filter.currency === undefined || entry.lines.some((line) => currencyOf.get(line.accountId) === filter.currency))
      .filter((entry) => filter.from === undefined || entry.period >= filter.from)
      .filter((entry) => filter.to === undefined || entry.period <= filter.to)
      .filter((entry) => filter.sourcePrefix === undefined || entry.sourceKey.startsWith(filter.sourcePrefix))
      .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.entryId < b.entryId ? 1 : -1))
      .filter((entry) => cursor === null || entry.at.getTime() < cursor.at.getTime() || (entry.at.getTime() === cursor.at.getTime() && entry.entryId < cursor.entryId))
      .slice(0, limit);
  }
}

function paid(id: number, stars: bigint = 50n, patch: { at?: Date; memo?: string } = {}) {
  return {
    sourceKey: `purchase:${id}:paid`,
    at: patch.at ?? AT,
    memo: patch.memo ?? "Набор «Старт»",
    lines: [
      { accountId: "stars.bot.hold", amount: stars },
      { accountId: "revenue.shop.telegram", amount: -stars },
    ],
  };
}

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe("журнал учёта: запись проводки", () => {
  let repository: MemoryLedgerRepository;
  let service: LedgerService;

  beforeEach(() => {
    repository = new MemoryLedgerRepository();
    service = new LedgerService(repository);
  });

  it("оплата набора записывается одной проводкой: период по UTC, автор — сервер", async () => {
    const result = await service.post(paid(42));

    expect(result.created).toBe(true);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]).toMatchObject({ entryId: result.entryId, sourceKey: "purchase:42:paid", period: "2026-11", memo: "Набор «Старт»", createdBy: null, reversalOf: null });
    expect(repository.entries[0]?.lines).toEqual(paid(42).lines);
  });

  it("период берётся по UTC: полночь по Москве уже следующий месяц, а по UTC ещё нет", async () => {
    await service.post(paid(1, 50n, { at: new Date("2026-10-31T22:30:00Z") }));

    expect(repository.entries[0]?.period).toBe("2026-10");
  });

  it("проводку вносит человек — в createdBy его аккаунт", async () => {
    const actor = { accountId: randomUUID() };

    await service.post(paid(43), actor);

    expect(repository.entries[0]?.createdBy).toBe(actor.accountId);
  });

  it("несбалансированная проводка — 400 ledger_entry_invalid с русским текстом, в журнал ничего не пишется", async () => {
    const error = await rejection(
      service.post({
        sourceKey: "purchase:1:paid",
        at: AT,
        memo: "кривая",
        lines: [
          { accountId: "stars.bot.hold", amount: 50n },
          { accountId: "revenue.shop.telegram", amount: -40n },
        ],
      }),
    );

    expect(error).toBeInstanceOf(LedgerEntryInvalidError);
    expect(error).toMatchObject({ code: "ledger_entry_invalid", status: 400 });
    expect(error.message).toContain("не сходится");
    expect(error.message).toContain("XTR");
    expect(repository.entries).toHaveLength(0);
  });

  it.each([
    ["неизвестный счёт", { sourceKey: "k:1", lines: [{ accountId: "stars.bot.hold", amount: 5n }, { accountId: "nope.account", amount: -5n }] }, "nope.account"],
    ["строка с нулём", { sourceKey: "k:2", lines: [{ accountId: "stars.bot.hold", amount: 0n }, { accountId: "revenue.shop.telegram", amount: 0n }] }, "нулев"],
    ["меньше двух строк", { sourceKey: "k:3", lines: [{ accountId: "stars.bot.hold", amount: 5n }] }, "меньше двух"],
    ["тот же счёт дважды", { sourceKey: "k:4", lines: [{ accountId: "stars.bot.hold", amount: 5n }, { accountId: "stars.bot.hold", amount: -5n }] }, "stars.bot.hold"],
    ["пустой ключ источника", { sourceKey: " ", lines: paid(1).lines }, "ключ"],
    ["слишком длинный ключ", { sourceKey: "k".repeat(129), lines: paid(1).lines }, "128"],
  ])("невалидная проводка — %s: 400 и текст про это", async (_name, patch, fragment) => {
    const error = await rejection(service.post({ at: AT, memo: "проверка", ...patch }));

    expect(error).toBeInstanceOf(LedgerEntryInvalidError);
    expect(error.status).toBe(400);
    expect(error.message).toContain(fragment);
    expect(repository.entries).toHaveLength(0);
  });

  it("описание длиннее 500 знаков и неопределённая дата — тоже 400, а не ошибка базы", async () => {
    const long = await rejection(service.post(paid(1, 50n, { memo: "я".repeat(501) })));
    const noDate = await rejection(service.post(paid(2, 50n, { at: new Date(Number.NaN) })));

    expect(long).toMatchObject({ code: "ledger_entry_invalid", status: 400 });
    expect(noDate).toMatchObject({ code: "ledger_entry_invalid", status: 400 });
    expect(repository.entries).toHaveLength(0);
  });

  it("повтор с теми же строками — та же проводка, created: false; описание и время повтора не важны", async () => {
    const first = await service.post(paid(42));

    const again = await service.post({ ...paid(42, 50n, { memo: "повторное задание" }), at: new Date("2026-11-14T00:00:00Z"), lines: [...paid(42).lines].reverse() });

    expect(again).toEqual({ entryId: first.entryId, created: false });
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.memo).toBe("Набор «Старт»");
  });

  it("тот же ключ с другими строками — 409 ledger_source_conflict, старая проводка не тронута", async () => {
    await service.post(paid(42));

    const error = await rejection(service.post(paid(42, 60n)));

    expect(error).toBeInstanceOf(LedgerSourceConflictError);
    expect(error).toMatchObject({ code: "ledger_source_conflict", status: 409 });
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.lines[0]?.amount).toBe(50n);
  });

  it("гонка двух записей одного ключа: проигравшая перечитывает и отдаёт ту же проводку", async () => {
    const winner = randomUUID();
    repository.rival = () => {
      repository.entries.push({
        entryId: winner,
        sourceKey: "purchase:7:paid",
        at: AT,
        period: "2026-11",
        memo: "Набор «Старт»",
        reversalOf: null,
        meta: null,
        createdBy: null,
        createdAt: new Date(),
        lines: paid(7).lines,
      });
    };

    const result = await service.post(paid(7));

    expect(result).toEqual({ entryId: winner, created: false });
    expect(repository.entries).toHaveLength(1);
  });

  it("гонка с другими строками у победителя — 409, а не тихая перезапись", async () => {
    repository.rival = () => {
      repository.entries.push({
        entryId: randomUUID(),
        sourceKey: "purchase:8:paid",
        at: AT,
        period: "2026-11",
        memo: "Набор «Старт»",
        reversalOf: null,
        meta: null,
        createdBy: null,
        createdAt: new Date(),
        lines: paid(8, 60n).lines,
      });
    };

    const error = await rejection(service.post(paid(8)));

    expect(error).toBeInstanceOf(LedgerSourceConflictError);
    expect(repository.entries).toHaveLength(1);
  });

  it("справочник счетов кэшируется: вторая проводка не читает его заново, а истёкший срок — читает", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T12:00:00Z") });
    try {
      await service.post(paid(1));
      await service.post(paid(2));
      expect(repository.accountReads).toBe(1);

      vi.setSystemTime(new Date("2026-11-13T12:01:01Z"));
      await service.post(paid(3));
      expect(repository.accountReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("счёт, заведённый после кэша, находится перечитыванием, а не отказом «неизвестный счёт»", async () => {
    await service.post(paid(1));
    repository.accountRows.push({ accountId: "revenue.donation.telegram", type: "revenue", currency: "XTR", name: "Донаты, Telegram", archivedAt: null });

    const result = await service.post({
      sourceKey: "purchase:2:paid",
      at: AT,
      memo: "Донат",
      lines: [
        { accountId: "stars.bot.hold", amount: 10n },
        { accountId: "revenue.donation.telegram", amount: -10n },
      ],
    });

    expect(result.created).toBe(true);
    expect(repository.accountReads).toBe(2);
  });

  it("счёта нет и после перечитывания — отказ, а справочник перечитывается один раз", async () => {
    await service.post(paid(1));
    const before = repository.accountReads;

    const error = await rejection(
      service.post({
        sourceKey: "k:9",
        at: AT,
        memo: "нет счёта",
        lines: [
          { accountId: "stars.bot.hold", amount: 1n },
          { accountId: "ghost", amount: -1n },
        ],
      }),
    );

    expect(error.message).toContain("ghost");
    expect(repository.accountReads - before).toBe(1);
  });

  it("мета проводки сохраняется и в повторе не сравнивается", async () => {
    await service.post({ ...paid(5), meta: { purchaseId: "5", method: "stars" } });

    const again = await service.post({ ...paid(5), meta: { purchaseId: "other" } });

    expect(again.created).toBe(false);
    expect(repository.entries[0]?.meta).toEqual({ purchaseId: "5", method: "stars" });
  });
});

describe("журнал учёта: сторно", () => {
  let repository: MemoryLedgerRepository;
  let service: LedgerService;

  beforeEach(() => {
    repository = new MemoryLedgerRepository();
    service = new LedgerService(repository);
  });

  it("сторно — обратные знаки строк и ссылка на исходную проводку", async () => {
    const original = await service.post(paid(42));

    const result = await service.reverse("purchase:42:paid", "purchase:42:refunded", new Date("2026-11-20T09:00:00Z"), "Возврат звёзд");

    expect(result.created).toBe(true);
    const stored = repository.entries.find((entry) => entry.entryId === result.entryId);
    expect(stored).toMatchObject({ sourceKey: "purchase:42:refunded", reversalOf: "purchase:42:paid", memo: "Возврат звёзд", period: "2026-11" });
    expect(stored?.lines).toEqual([
      { accountId: "stars.bot.hold", amount: -50n },
      { accountId: "revenue.shop.telegram", amount: 50n },
    ]);
    expect(result.entryId).not.toBe(original.entryId);
  });

  it("повтор того же сторно — та же проводка; второе сторно исходной под другим ключом — 409 ledger_already_reversed", async () => {
    await service.post(paid(42));
    const first = await service.reverse("purchase:42:paid", "purchase:42:refunded", AT, "Возврат");

    const again = await service.reverse("purchase:42:paid", "purchase:42:refunded", AT, "Возврат");
    const second = await rejection(service.reverse("purchase:42:paid", "purchase:42:refunded-2", AT, "Ещё раз"));

    expect(again).toEqual({ entryId: first.entryId, created: false });
    expect(second).toBeInstanceOf(LedgerAlreadyReversedError);
    expect(second).toMatchObject({ code: "ledger_already_reversed", status: 409 });
    expect(repository.entries).toHaveLength(2);
  });

  it("сторно проводки, которой нет, — 404 ledger_entry_not_found", async () => {
    const error = await rejection(service.reverse("purchase:404:paid", "purchase:404:refunded", AT, "Возврат"));

    expect(error).toBeInstanceOf(LedgerEntryNotFoundError);
    expect(error).toMatchObject({ code: "ledger_entry_not_found", status: 404 });
  });

  it("сторно сторно — обычная проводка: возврат отменили", async () => {
    await service.post(paid(42));
    await service.reverse("purchase:42:paid", "purchase:42:refunded", AT, "Возврат");

    const undone = await service.reverse("purchase:42:refunded", "purchase:42:refund-undone", AT, "Возврат отменён");

    expect(undone.created).toBe(true);
    expect(repository.entries.at(-1)?.lines).toEqual(paid(42).lines);
  });

  it("ключ сторно уже занят проводкой с другими строками — 409 ledger_source_conflict", async () => {
    await service.post(paid(42));
    await service.post(paid(43));

    const error = await rejection(service.reverse("purchase:42:paid", "purchase:43:paid", AT, "Возврат"));

    expect(error).toBeInstanceOf(LedgerSourceConflictError);
  });

  it("сторно с ключом исходной, которой нет, прямым post — 400, а не висящая ссылка", async () => {
    const error = await rejection(service.post({ ...paid(1), sourceKey: "purchase:1:refunded", reversalOf: "purchase:ghost:paid" }));

    expect(error).toBeInstanceOf(LedgerEntryInvalidError);
    expect(error.message).toContain("purchase:ghost:paid");
  });
});

describe("журнал учёта: остатки", () => {
  let repository: MemoryLedgerRepository;
  let service: LedgerService;

  beforeEach(() => {
    repository = new MemoryLedgerRepository();
    service = new LedgerService(repository);
  });

  const balanceOf = async (accountId: string) => (await service.balances()).find((row) => row.accountId === accountId)?.balance;

  it("до проводок все счета плана с нулём", async () => {
    const rows = await service.balances();

    expect(rows.map((row) => row.accountId).sort()).toEqual(PLAN.map((row) => row.accountId).sort());
    // знаки после запятой — по валюте счёта: у звёзд «0», у рубля «0.00», у Gram — девять
    expect(rows.map((row) => [row.accountId, row.balance])).toContainEqual(["stars.bot.hold", "0"]);
    expect(rows.map((row) => [row.accountId, row.balance])).toContainEqual(["bank.rub", "0.00"]);
    expect(rows.map((row) => [row.accountId, row.balance])).toContainEqual(["wallet.ton", "0.000000000"]);
  });

  it("оплата на 50 ⭐: холд 50 и выручка 50 — обе по нормальной стороне положительны", async () => {
    await service.post(paid(42));

    expect(await service.balances()).toContainEqual({ accountId: "stars.bot.hold", name: "Звёзды бота — в холде", type: "asset", currency: "XTR", balance: "50" });
    expect(await service.balances()).toContainEqual({ accountId: "revenue.shop.telegram", name: "Выручка: магазин, Telegram", type: "revenue", currency: "XTR", balance: "50" });
  });

  it("после сторно остатки возвращаются к нулю", async () => {
    await service.post(paid(42));
    await service.reverse("purchase:42:paid", "purchase:42:refunded", AT, "Возврат");

    expect(await balanceOf("stars.bot.hold")).toBe("0");
    expect(await balanceOf("revenue.shop.telegram")).toBe("0");
  });

  it("суммы — строками по знакам валюты: нано-Gram и копейки без потери точности", async () => {
    repository.accountRows.push({ accountId: "exchange.gram", type: "asset", currency: "GRAM", name: "Обмен, Gram", archivedAt: null });
    await service.post({
      sourceKey: "wd:1",
      at: AT,
      memo: "Приход на кошелёк",
      lines: [
        { accountId: "wallet.ton", amount: 9_007_199_254_740_993n },
        { accountId: "exchange.gram", amount: -9_007_199_254_740_993n },
      ],
    });

    expect(await balanceOf("wallet.ton")).toBe("9007199.254740993");
    // обмен — актив, у него «по дебету» значит плюс, и кредит даёт минус
    expect(await balanceOf("exchange.gram")).toBe("-9007199.254740993");
  });

  it("счёт, заведённый после кэша, в остатках есть", async () => {
    await service.balances();
    repository.accountRows.push({ accountId: "revenue.donation.telegram", type: "revenue", currency: "XTR", name: "Донаты, Telegram", archivedAt: null });

    expect((await service.balances()).map((row) => row.accountId)).toContain("revenue.donation.telegram");
  });
});

describe("журнал учёта: страницы", () => {
  let repository: MemoryLedgerRepository;
  let service: LedgerService;

  beforeEach(async () => {
    repository = new MemoryLedgerRepository();
    service = new LedgerService(repository);
    for (let id = 1; id <= 5; id += 1) {
      await service.post(paid(id, BigInt(id * 10), { at: new Date(Date.UTC(2026, 9 + (id > 3 ? 1 : 0), id, 12)), memo: `Покупка ${id}` }));
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("проводки новые сверху, суммы строками со знаком, у строк имя счёта и валюта", async () => {
    const page = await service.journal({}, null);

    expect(page.next).toBeNull();
    expect(page.entries.map((entry) => entry.sourceKey)).toEqual(["purchase:5:paid", "purchase:4:paid", "purchase:3:paid", "purchase:2:paid", "purchase:1:paid"]);
    expect(page.entries[0]).toMatchObject({
      sourceKey: "purchase:5:paid",
      at: "2026-11-05T12:00:00.000Z",
      period: "2026-11",
      memo: "Покупка 5",
      reversalOf: null,
      createdBy: null,
      lines: [
        { accountId: "stars.bot.hold", accountName: "Звёзды бота — в холде", currency: "XTR", amount: "50" },
        { accountId: "revenue.shop.telegram", accountName: "Выручка: магазин, Telegram", currency: "XTR", amount: "-50" },
      ],
    });
  });

  it("лимит режет страницу и даёт курсор; по курсору — следующая, без пропусков и повторов", async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await service.journal({}, cursor, 2);
      collected.push(...page.entries.map((entry) => entry.sourceKey));
      cursor = page.next;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(collected).toEqual(["purchase:5:paid", "purchase:4:paid", "purchase:3:paid", "purchase:2:paid", "purchase:1:paid"]);
  });

  it("точное число проводок на последней странице — курсора нет", async () => {
    const page = await service.journal({}, null, 5);

    expect(page.entries).toHaveLength(5);
    expect(page.next).toBeNull();
  });

  it("фильтры: период, ключ по префиксу, счёт, валюта", async () => {
    expect((await service.journal({ from: "2026-11", to: "2026-11" }, null)).entries.map((entry) => entry.sourceKey)).toEqual(["purchase:5:paid", "purchase:4:paid"]);
    expect((await service.journal({ sourcePrefix: "purchase:3" }, null)).entries.map((entry) => entry.sourceKey)).toEqual(["purchase:3:paid"]);
    expect((await service.journal({ accountId: "revenue.shop.telegram" }, null)).entries).toHaveLength(5);
    expect((await service.journal({ accountId: "wallet.ton" }, null)).entries).toHaveLength(0);
    expect((await service.journal({ currency: "GRAM" }, null)).entries).toHaveLength(0);
    expect((await service.journal({ currency: "XTR" }, null)).entries).toHaveLength(5);
  });

  it("лимит вне 1…100 — 400; нечитаемый курсор — 400 ledger_cursor_invalid", async () => {
    await expect(service.journal({}, null, 0)).rejects.toMatchObject({ status: 400 });
    await expect(service.journal({}, null, 101)).rejects.toMatchObject({ status: 400 });
    const error = await rejection(service.journal({}, "это-не-курсор"));
    expect(error).toBeInstanceOf(LedgerCursorInvalidError);
    expect(error).toMatchObject({ code: "ledger_cursor_invalid", status: 400 });
  });

  it("у сторно в журнале виден ключ исходной проводки", async () => {
    await service.reverse("purchase:3:paid", "purchase:3:refunded", new Date("2026-12-01T00:00:00Z"), "Возврат");

    const [top] = (await service.journal({}, null, 1)).entries;

    expect(top).toMatchObject({ sourceKey: "purchase:3:refunded", reversalOf: "purchase:3:paid", period: "2026-12" });
    expect(top?.lines[0]?.amount).toBe("-30");
  });
});
