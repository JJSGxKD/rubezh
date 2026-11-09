import { describe, expect, it } from "vitest";
import { resultsLook } from "../src/screens/run/results-look";

// Тон и заголовок окна итогов по исходу (tasks/T-0232, Р145).

describe("облик окна итогов", () => {
  it("пал — тон акцента, заголовок забега", () => {
    expect(resultsLook("died", false, false)).toEqual({ tone: "var(--color-accent)", titleKey: "run.death.title", icon: "skull" });
  });

  it("сдался — приглушённый тон и прежний заголовок", () => {
    expect(resultsLook("abandoned", false, false)).toEqual({ tone: "var(--color-text-muted)", titleKey: "run.death.abandoned", icon: "skull" });
  });

  it("новый рекорд — тон элиты и корона, заголовок исхода прежний", () => {
    expect(resultsLook("died", true, false)).toEqual({ tone: "var(--color-elite)", titleKey: "run.death.title", icon: "crown" });
    expect(resultsLook("abandoned", true, false).titleKey).toBe("run.death.abandoned");
  });

  it("Рубеж удержан — вторичный тон и заголовок рубежа", () => {
    expect(resultsLook("died", false, true)).toEqual({ tone: "var(--color-secondary)", titleKey: "run.rubezh.cleared.title", icon: "skull" });
  });

  it("Рубеж с рекордом — тон элиты, корона и заголовок рубежа", () => {
    expect(resultsLook("died", true, true)).toEqual({ tone: "var(--color-elite)", titleKey: "run.rubezh.cleared.title", icon: "crown" });
  });
});
