import type { RunOutcome } from "@bh/shared-types";

/**
 * Облик окна итогов забега (tasks/T-0232, Р145): тон реликвии, ключ заголовка
 * на ленте и значок медальона. Тон говорит, чем кончился забег; рекорд важнее
 * рубежа — удержал Рубеж с рекордом, окно золотое. Окно «Рубеж удержан!» пролога
 * (T-0280) берёт эту функцию и тот же медальон, а не пишет свою.
 */
export interface ResultsLook {
  /** CSS-значение из токенов — `relic` у `Modal` и `tone` у `RibbonTitle` */
  tone: string;
  /** ключ заголовка на ленте; тексты исходов прежние */
  titleKey: string;
  icon: "skull" | "crown";
}

export function resultsLook(outcome: RunOutcome, isNewRecord: boolean, rubezhCleared: boolean): ResultsLook {
  const titleKey = rubezhCleared ? "run.rubezh.cleared.title" : outcome === "died" ? "run.death.title" : "run.death.abandoned";
  if (isNewRecord) return { tone: "var(--color-elite)", titleKey, icon: "crown" };
  if (rubezhCleared) return { tone: "var(--color-secondary)", titleKey, icon: "skull" };
  return { tone: outcome === "died" ? "var(--color-accent)" : "var(--color-text-muted)", titleKey, icon: "skull" };
}
