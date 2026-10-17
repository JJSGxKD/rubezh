import { describe, expect, it } from "vitest";
import { paidErrorText } from "../src/screens/run/paid-continue-rules";

// Текст отказа оплаты второго шанса: ограничение «Покупки» говорит словами сервера.

describe("paidErrorText", () => {
  it("account_restricted с текстом — текст сервера", () => {
    expect(paidErrorText("account_restricted", "Покупки закрыты: возврат оплаты")).toEqual({ text: "Покупки закрыты: возврат оплаты" });
  });

  it("account_restricted без текста — общий ключ ошибки оплаты", () => {
    expect(paidErrorText("account_restricted", null)).toEqual({ key: "run.continue.retry.payment_failed" });
    expect(paidErrorText("account_restricted", "  ")).toEqual({ key: "run.continue.retry.payment_failed" });
  });

  it("temporarily_unavailable — ключ временной недоступности, текст сервера не берётся", () => {
    expect(paidErrorText("temporarily_unavailable", "Сейчас недоступно")).toEqual({ key: "run.continue.unavailable.not_offered" });
  });

  it("остальное — прежний ключ ошибки оплаты", () => {
    expect(paidErrorText(null, null)).toEqual({ key: "run.continue.retry.payment_failed" });
    expect(paidErrorText("payments_unavailable", "x")).toEqual({ key: "run.continue.retry.payment_failed" });
  });
});
