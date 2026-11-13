import { describe, expect, it } from "vitest";
import {
  compare,
  DISCREPANCY_KINDS,
  due,
  RECONCILE,
  settled,
  startOffset,
  windowOf,
  type CompareInput,
  type KnownPurchase,
} from "../src/modules/payments/payment-reconcile.js";
import type { StatementEntry } from "../src/platforms/ports/payment-statement.js";

/**
 * Правила сверки оплат с выпиской площадки (tasks/T-0433, Р209, WP53): что
 * считается расхождением, с какого места читать выписку, когда пора сверять и
 * что закрывается само. Чистые функции — ни базы, ни Nest, ни площадки.
 */

const NOW = new Date("2026-11-13T12:00:00Z");
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

/** Минут до `NOW`. */
const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

function entry(patch: Partial<StatementEntry> = {}): StatementEntry {
  return { id: "charge-1", kind: "payment", amount: 50, at: ago(120), payerId: "555000111", payload: PURCHASE_ID, subscriptionPeriodSec: null, ...patch };
}

function known(patch: Partial<KnownPurchase> = {}): KnownPurchase {
  return { purchaseId: PURCHASE_ID, accountId: ACCOUNT_ID, chargeId: "charge-1", chargedStars: 50, paidAt: ago(60), refundedAt: null, ...patch };
}

function input(patch: Partial<CompareInput> = {}): CompareInput {
  return { entries: [], byCharge: new Map(), byPayload: new Map(), paidInWindow: [], now: NOW, ...patch };
}

function byCharge(...purchases: KnownPurchase[]): ReadonlyMap<string, KnownPurchase> {
  return new Map(purchases.map((purchase) => [purchase.chargeId, purchase]));
}

describe("compare: «списано, но не записано»", () => {
  it("оплата из выписки без покупки, старше 15 минут, payload — id существующей покупки: с покупкой и аккаунтом", () => {
    const found = compare(
      input({
        entries: [entry({ id: "charge-9", at: ago(120), payload: PURCHASE_ID, payerId: "555000111", amount: 75 })],
        byPayload: new Map([[PURCHASE_ID, { purchaseId: PURCHASE_ID, accountId: ACCOUNT_ID }]]),
      }),
    );

    expect(found).toEqual([
      {
        kind: "charged_unrecorded",
        chargeId: "charge-9",
        purchaseId: PURCHASE_ID,
        accountId: ACCOUNT_ID,
        payerId: "555000111",
        amount: 75,
        payload: PURCHASE_ID,
        occurredAt: ago(120),
      },
    ]);
  });

  it("та же оплата моложе 15 минут — ничего: очередь могла ещё не записать её", () => {
    expect(compare(input({ entries: [entry({ at: ago(14) })] }))).toEqual([]);
  });

  it("окно свежести — ровно 15 минут: 16 минут назад уже сверяется", () => {
    expect(RECONCILE.graceMs).toBe(15 * 60_000);
    expect(compare(input({ entries: [entry({ at: ago(16) })] }))).toHaveLength(1);
  });

  it("payload чужой — покупки и аккаунта нет", () => {
    const [found] = compare(input({ entries: [entry({ payload: "чужой-счёт" })] }));

    expect(found).toMatchObject({ kind: "charged_unrecorded", purchaseId: null, accountId: null, payload: "чужой-счёт" });
  });

  it("payload нет вовсе — расхождение есть, покупки нет", () => {
    const [found] = compare(input({ entries: [entry({ payload: null })] }));

    expect(found).toMatchObject({ kind: "charged_unrecorded", purchaseId: null, payload: null });
  });

  it("payload обрезается до 128 знаков", () => {
    const [found] = compare(input({ entries: [entry({ payload: "я".repeat(300) })] }));

    expect(found?.payload).toBe("я".repeat(128));
  });

  it("оплата, которая у нас записана, — ничего", () => {
    expect(compare(input({ entries: [entry()], byCharge: byCharge(known()) }))).toEqual([]);
  });
});

describe("compare: «возврат в Telegram, но не у нас»", () => {
  const refund = (patch: Partial<StatementEntry> = {}): StatementEntry => entry({ kind: "refund", id: "charge-1", at: ago(100), amount: 50, ...patch });

  it("возврат по оплате нашей покупки с пустым refundedAt — расхождение с покупкой и аккаунтом", () => {
    const found = compare(input({ entries: [refund()], byCharge: byCharge(known({ refundedAt: null })) }));

    expect(found).toEqual([
      {
        kind: "refund_unrecorded",
        chargeId: "charge-1",
        purchaseId: PURCHASE_ID,
        accountId: ACCOUNT_ID,
        payerId: "555000111",
        amount: 50,
        payload: PURCHASE_ID,
        occurredAt: ago(100),
      },
    ]);
  });

  it("refundedAt заполнен — ничего", () => {
    expect(compare(input({ entries: [refund()], byCharge: byCharge(known({ refundedAt: ago(90) })) }))).toEqual([]);
  });

  it("возврат по оплате, которой у нас нет, — не расхождение", () => {
    expect(compare(input({ entries: [refund({ id: "charge-чужая" })], byCharge: byCharge(known()) }))).toEqual([]);
  });

  it("возврат моложе 15 минут — ничего: наша отметка могла ещё не лечь", () => {
    expect(compare(input({ entries: [refund({ at: ago(10) })], byCharge: byCharge(known()) }))).toEqual([]);
  });
});

describe("compare: «записано, но нет в выписке»", () => {
  /** Выписка за два часа без интересующей оплаты: операции на отметках −120 и −20 минут. */
  const statement = [entry({ id: "charge-a", at: ago(120), payload: null }), entry({ id: "charge-b", at: ago(20), payload: null })];
  const recorded = (patch: Partial<KnownPurchase> = {}): KnownPurchase => known({ chargeId: "charge-z", chargedStars: 150, paidAt: ago(60), ...patch });
  const known_ = (...purchases: KnownPurchase[]) => byCharge(...purchases);

  it("оплаченная покупка внутри окна без оплаты в выписке — расхождение с суммой chargedStars и временем оплаты", () => {
    const purchase = recorded();
    const found = compare(input({ entries: statement, byCharge: known_(known({ chargeId: "charge-a" }), known({ chargeId: "charge-b" })), paidInWindow: [purchase] }));

    expect(found).toEqual([
      {
        kind: "recorded_missing",
        chargeId: "charge-z",
        purchaseId: PURCHASE_ID,
        accountId: ACCOUNT_ID,
        payerId: null,
        amount: 150,
        payload: null,
        occurredAt: ago(60),
      },
    ]);
  });

  it("оплата на 10 минут позже первой операции — внутри запаса в 30 минут, ничего", () => {
    expect(compare(input({ entries: statement, byCharge: known_(known({ chargeId: "charge-a" }), known({ chargeId: "charge-b" })), paidInWindow: [recorded({ paidAt: ago(110) })] }))).toEqual([]);
  });

  it("запас — ровно 30 минут: на границе покупка уже сверяется", () => {
    expect(RECONCILE.edgeMs).toBe(30 * 60_000);
    const found = compare(input({ entries: statement, byCharge: known_(known({ chargeId: "charge-a" }), known({ chargeId: "charge-b" })), paidInWindow: [recorded({ paidAt: ago(90) })] }));

    expect(found).toHaveLength(1);
  });

  it("оплата позже последней операции выписки — ничего: до неё чтение не дошло", () => {
    expect(compare(input({ entries: statement, byCharge: known_(known({ chargeId: "charge-a" }), known({ chargeId: "charge-b" })), paidInWindow: [recorded({ paidAt: ago(5) })] }))).toEqual([]);
  });

  it("оплата, которая в выписке есть, — ничего", () => {
    const present = [...statement, entry({ id: "charge-z", at: ago(60), payload: null })];

    expect(compare(input({ entries: present, byCharge: known_(recorded(), known({ chargeId: "charge-a" }), known({ chargeId: "charge-b" })), paidInWindow: [recorded()] }))).toEqual([]);
  });

  it("возврат с тем же id оплатой не считается: в выписке нет самой оплаты", () => {
    const onlyRefund = [...statement, entry({ id: "charge-z", kind: "refund", at: ago(60), payload: null })];

    expect(compare(input({ entries: onlyRefund, byCharge: known_(recorded()), paidInWindow: [recorded()] })).map((found) => found.kind)).toContain("recorded_missing");
  });

  it("пустая выписка — окна нет, ничего не ищется", () => {
    expect(compare(input({ entries: [], paidInWindow: [recorded()] }))).toEqual([]);
  });
});

describe("compare: прочее", () => {
  it("операции other не сверяются", () => {
    expect(compare(input({ entries: [entry({ kind: "other", id: "fee-1" })] }))).toEqual([]);
  });

  it("повтор одного id в выписке — одна находка", () => {
    const found = compare(input({ entries: [entry({ id: "charge-7", at: ago(130) }), entry({ id: "charge-7", at: ago(120) })] }));

    expect(found).toHaveLength(1);
  });

  it("оплата и возврат с одним id по неизвестной оплате — одно расхождение «списано»: возврату сверять нечего", () => {
    const found = compare(input({ entries: [entry({ id: "charge-8", at: ago(130) }), entry({ id: "charge-8", kind: "refund", at: ago(120) })] }));

    expect(found.map((item) => item.kind)).toEqual(["charged_unrecorded"]);
  });

  it("порядок находок — по выписке, от старых к новым", () => {
    const found = compare(input({ entries: [entry({ id: "a", at: ago(130) }), entry({ id: "b", at: ago(125) }), entry({ id: "c", at: ago(120) })] }));

    expect(found.map((item) => item.chargeId)).toEqual(["a", "b", "c"]);
  });
});

describe("windowOf: отрезок, внутри которого ищутся «записано, но нет»", () => {
  it("пустая выписка — null", () => {
    expect(windowOf([])).toBeNull();
  });

  it("от первой операции плюс 30 минут до последней", () => {
    expect(windowOf([entry({ at: ago(120) }), entry({ at: ago(60) }), entry({ at: ago(20) })])).toEqual({ from: ago(90), to: ago(20) });
  });

  it("выписка короче запаса — отрезка нет: сверять нечего", () => {
    expect(windowOf([entry({ at: ago(120) }), entry({ at: ago(100) })])).toBeNull();
  });
});

describe("startOffset: с какой позиции читать выписку", () => {
  it("прошлой удачной сверки нет — с нуля", () => {
    expect(startOffset(null)).toBe(0);
  });

  it("прошлая дочитала до 250 — с 150: перекрытие в 100 операций", () => {
    expect(startOffset(250)).toBe(150);
  });

  it("перекрытие не уводит ниже нуля", () => {
    expect(startOffset(40)).toBe(0);
    expect(startOffset(0)).toBe(0);
  });
});

describe("due: пора ли сверять по расписанию", () => {
  it("удачной сверки не было — пора", () => {
    expect(due(null, NOW)).toBe(true);
  });

  it("прошло 22 часа — рано", () => {
    expect(due(new Date(NOW.getTime() - 22 * 3_600_000), NOW)).toBe(false);
  });

  it("прошло 24 часа — пора", () => {
    expect(due(new Date(NOW.getTime() - 24 * 3_600_000), NOW)).toBe(true);
  });
});

describe("settled: что закрывается само", () => {
  const open = [
    { discrepancyId: "d1", kind: "charged_unrecorded" as const, chargeId: "a" },
    { discrepancyId: "d2", kind: "refund_unrecorded" as const, chargeId: "b" },
    { discrepancyId: "d3", kind: "recorded_missing" as const, chargeId: "c" },
    { discrepancyId: "d4", kind: "charged_unrecorded" as const, chargeId: "d" },
    { discrepancyId: "d5", kind: "refund_unrecorded" as const, chargeId: "e" },
    { discrepancyId: "d6", kind: "recorded_missing" as const, chargeId: "f" },
  ];
  const none = new Set<string>();

  it("записанная оплата, отмеченный возврат и найденная в выписке оплата закрываются; остальные — нет", () => {
    const result = settled(open, { recordedCharges: new Set(["a"]), refundedCharges: new Set(["b"]), statementPayments: new Set(["c"]) });

    expect(result).toEqual(["d1", "d2", "d3"]);
  });

  it("каждый вид закрывается своим условием: чужое условие не годится", () => {
    const result = settled(open, { recordedCharges: new Set(["b", "c"]), refundedCharges: new Set(["a", "c"]), statementPayments: new Set(["a", "b"]) });

    expect(result).toEqual([]);
  });

  it("ничего не сошлось — ничего не закрыто", () => {
    expect(settled(open, { recordedCharges: none, refundedCharges: none, statementPayments: none })).toEqual([]);
  });
});

describe("RECONCILE: числа сверки", () => {
  it("совпадают с решением Р209", () => {
    expect(RECONCILE).toMatchObject({
      pageSize: 100,
      maxPages: 100,
      overlap: 100,
      minIntervalMs: 23 * 3_600_000,
      tickMs: 3_600_000,
      firstTickMs: 5 * 60_000,
      lockTtlMs: 15 * 60_000,
      pageTimeoutMs: 20_000,
    });
  });

  it("видов расхождений три", () => {
    expect([...DISCREPANCY_KINDS]).toEqual(["charged_unrecorded", "recorded_missing", "refund_unrecorded"]);
  });
});
