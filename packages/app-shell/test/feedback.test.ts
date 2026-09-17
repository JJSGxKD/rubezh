import { describe, expect, it } from "vitest";
import { shouldAskFeedback } from "../src/state/feedback";

// Когда звать игрока оставить отзыв (docs/29-admin-panel.md §6): после
// первого забега и дальше раз в десяток. Спрашивать каждый запуск — верный
// способ, чтобы форму перестали замечать.

describe("когда звать за отзывом", () => {
  it("молчит, пока игрок не сыграл ни разу", () => {
    expect(shouldAskFeedback(0, null)).toBe(false);
  });

  it("зовёт после первого забега", () => {
    expect(shouldAskFeedback(1, null)).toBe(true);
  });

  it("не зовёт сразу после отправленного отзыва", () => {
    expect(shouldAskFeedback(4, 3)).toBe(false);
  });

  it("зовёт снова через десяток забегов", () => {
    expect(shouldAskFeedback(13, 3)).toBe(true);
  });
});
