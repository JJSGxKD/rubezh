import { describe, expect, it } from "vitest";
import { attentionResponseSchema, attentionTotal } from "../src/api/attention";
import { badgeText } from "../src/state/use-attention";

// Счётчик «Ждёт вас» у пункта «Сводка» (tasks/T-0359): сумма по пунктам и подпись знака.

describe("«Ждёт вас» в меню", () => {
  it("схема разбирает ответ сервера", () => {
    const parsed = attentionResponseSchema.parse({ items: [{ section: "broadcasts", count: 2, text: "Рассылки" }] });
    expect(parsed.items).toEqual([{ section: "broadcasts", count: 2, text: "Рассылки" }]);
    expect(attentionResponseSchema.safeParse({ items: [{ section: "x", count: "2", text: "" }] }).success).toBe(false);
  });

  it("число — сумма count по пунктам", () => {
    expect(attentionTotal([])).toBe(0);
    expect(attentionTotal([{ count: 2 }, { count: 1 }])).toBe(3);
  });

  it("знак: ноль — нет знака, больше 99 — «99+»", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(7)).toBe("7");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(120)).toBe("99+");
  });
});
