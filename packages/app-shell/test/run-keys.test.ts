import { describe, expect, it } from "vitest";
import { runKeyAction } from "../src/screens/run/run-keys";

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
