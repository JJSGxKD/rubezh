import { describe, expect, it } from "vitest";
import { walletCategory } from "../src/modules/history/history-types.js";
import { decodeHistoryCursor, encodeHistoryCursor } from "../src/modules/history/history.service.js";

// История имущества (docs/35-stage4-plan.md Р51): категории строк кошелька и
// свой формат курсора — остальное проверяет тест на живом Postgres.

describe("категория строки кошелька", () => {
  it("бусты и покупки — по причине, остальное делят ресурсы", () => {
    expect(walletCategory("coins", "boost")).toBe("boosts");
    expect(walletCategory("gems", "boost_refund")).toBe("boosts");
    expect(walletCategory("gems", "purchase")).toBe("purchases");
    expect(walletCategory("shard_rare", "salvage")).toBe("shards");
    expect(walletCategory("shard_common", "item_upgrade")).toBe("shards");
    expect(walletCategory("coins", "run_reward")).toBe("currency");
  });
});

describe("курсор истории", () => {
  it("свой формат туда и обратно; подделка — ошибка разбора, а не SQL", () => {
    const cursor = { at: new Date(Date.UTC(2026, 8, 30)), key: "w:00000000-0000-4000-8000-000000000001" };
    expect(decodeHistoryCursor(encodeHistoryCursor(cursor))).toEqual(cursor);
    expect(() => decodeHistoryCursor(Buffer.from("1|x:'; DROP TABLE wallet_entry; --").toString("base64url"))).toThrow(/курсор/);
    expect(() => decodeHistoryCursor("???")).toThrow(/курсор/);
  });
});
