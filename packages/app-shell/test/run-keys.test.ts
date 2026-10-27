import { describe, expect, it } from "vitest";
import { keyOwnedByTarget, runKeyAction } from "../src/screens/run/run-keys";

// Клавиатура в забеге (docs/35-stage4-plan.md, Р57): пауза, выбор, «Ещё раз» —
// по физическим клавишам, и ничего — на экране второго шанса.

describe("клавиши забега", () => {
  it("Esc и P ставят паузу и снимают её, Enter и пробел продолжают", () => {
    expect(runKeyAction("Escape", "running", 0)).toEqual({ kind: "pause" });
    expect(runKeyAction("KeyP", "running", 0)).toEqual({ kind: "pause" });
    expect(runKeyAction("Escape", "paused", 0)).toEqual({ kind: "resume" });
    expect(runKeyAction("Space", "paused", 0)).toEqual({ kind: "resume" });
    expect(runKeyAction("Enter", "running", 0)).toBeNull();
  });

  it("1–4 выбирают карточку — только из тех, что есть", () => {
    expect(runKeyAction("Digit1", "levelUp", 3)).toEqual({ kind: "choose", index: 0 });
    expect(runKeyAction("Numpad3", "levelUp", 3)).toEqual({ kind: "choose", index: 2 });
    expect(runKeyAction("Digit4", "levelUp", 3)).toBeNull();
    expect(runKeyAction("Digit4", "levelUp", 4)).toEqual({ kind: "choose", index: 3 });
  });

  it("на итоге Enter — «Ещё раз», а на втором шансе клавиш нет: Enter не купит продолжение", () => {
    expect(runKeyAction("Enter", "finished", 0)).toEqual({ kind: "restart" });
    for (const code of ["Enter", "Space", "Escape", "Digit1"]) expect(runKeyAction(code, "downed", 0)).toBeNull();
  });
});

describe("клавиша принадлежит тому, на чём фокус", () => {
  // Фокус ходит по окнам забега клавишей Tab (docs/27 §4.4): Enter на
  // «На главную» жал кнопку и тут же «Ещё раз» — забег перезапускался по дороге
  // на главную; пробел на «Сдаться» открывал подтверждение и снимал паузу.
  const button = { tagName: "BUTTON", role: null, editable: false };
  const dialog = { tagName: "DIV", role: "dialog", editable: false };
  const field = { tagName: "INPUT", role: null, editable: false };

  it("Enter и пробел на кнопке — кнопке, а не забегу", () => {
    expect(keyOwnedByTarget("Enter", button)).toBe(true);
    expect(keyOwnedByTarget("Space", button)).toBe(true);
    expect(keyOwnedByTarget("Space", { tagName: "DIV", role: "switch", editable: false })).toBe(true);
    expect(keyOwnedByTarget("Enter", { tagName: "A", role: null, editable: false })).toBe(true);
  });

  it("пауза и цифры выбора на кнопке — по-прежнему забегу", () => {
    expect(keyOwnedByTarget("Escape", button)).toBe(false);
    expect(keyOwnedByTarget("Digit1", button)).toBe(false);
  });

  it("фокус на самом окне — Enter остаётся «Ещё раз»", () => {
    expect(keyOwnedByTarget("Enter", dialog)).toBe(false);
  });

  it("поле ввода забирает любую клавишу", () => {
    expect(keyOwnedByTarget("KeyP", field)).toBe(true);
    expect(keyOwnedByTarget("Escape", { tagName: "DIV", role: null, editable: true })).toBe(true);
  });
});
