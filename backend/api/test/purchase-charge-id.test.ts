import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Идентификатор оплаты Telegram в новом формате `stx…` — 131 знак (11.11.2026),
// а колонка была VARCHAR(128): запись оплаты падала, звёзды списаны, покупка
// не отмечена. Колонка обязана вмещать всё, что пропускает проверка входа.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("длина идентификатора оплаты Telegram", () => {
  const schema = read("../prisma/schema.prisma");
  const api = read("../src/platforms/telegram/telegram-update-schema.ts");
  const column = /telegramChargeId\s+String\?\s+@unique\s+@map\("telegram_charge_id"\)\s+@db\.VarChar\((\d+)\)/.exec(schema);
  const input = /telegram_payment_charge_id:\s*z\.string\(\)\.min\(1\)\.max\((\d+)\)/.exec(api);

  it("колонка purchase.telegram_charge_id вмещает всё, что пропускает проверка входа", () => {
    expect(column, "колонка telegram_charge_id в schema.prisma").not.toBeNull();
    expect(input, "проверка telegram_payment_charge_id в telegram-update-schema.ts").not.toBeNull();
    expect(Number(column?.[1])).toBeGreaterThanOrEqual(Number(input?.[1]));
  });

  it("вмещает идентификатор нового формата stx… из прода", () => {
    const real = "stx2htf1qaeDZxvKbC-WIyQmQwXmgeoTLvwSF2jj85zgC2r3l17mYYBHs-U2N1OT3qiwiM5qMNF0VE8vI-992_0txwByYkFwujCm2tRNC5bmbGxPKHs3BtTTYZHzTGtdfma";
    expect(real.length).toBeGreaterThan(128);
    expect(Number(column?.[1])).toBeGreaterThanOrEqual(real.length);
  });
});
