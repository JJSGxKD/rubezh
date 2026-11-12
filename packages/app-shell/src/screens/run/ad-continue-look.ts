import type { AdContinueStage } from "../../state/ad-continue";

/** Вид кнопки второго шанса за рекламу в данной стадии. */
export interface AdButtonLook {
  /** Ролик — главное действие блока «Второй шанс» (макет, `.cbtn.ad`). */
  variant: "primary";
  loading: boolean;
  disabled: boolean;
  /** VIP-пропуск: ролика нет, на кнопке корона. */
  pass: boolean;
  /** Подпись на кнопке: короткая рядом со звёздами, полная — когда кнопка одна. */
  labelKey: string;
  /** Подпись, когда полной не хватает ширины сетки способов (Р210): одна строка всегда. */
  compactLabelKey: string;
  /** Подпись для скринридера: всегда полная. */
  ariaKey: string;
}

/** `null` — кнопки нет: за рекламу продолжить нельзя (отказ показывает строка под кнопками). */
export function adButtonLook(stage: AdContinueStage, options: { locked: boolean; wide: boolean }): AdButtonLook | null {
  if (stage.kind === "unavailable") return null;
  const pass = (stage.kind === "ready" || stage.kind === "watching") && stage.pass;
  const labelKey = pass ? (options.wide ? "run.continue.vip.wide" : "run.continue.vip.short") : options.wide ? "run.continue.ad" : "run.continue.ad.short";
  const compactLabelKey = !options.wide ? labelKey : pass ? "run.continue.vip.short" : "run.continue.ad.medium";
  return {
    variant: "primary",
    loading: stage.kind === "checking" || stage.kind === "watching",
    disabled: stage.kind !== "ready" || options.locked,
    pass,
    labelKey,
    compactLabelKey,
    ariaKey: pass ? "run.continue.vip" : "run.continue.ad",
  };
}
