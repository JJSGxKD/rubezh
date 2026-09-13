import type { UpgradeChange } from "@bh/shared-types";
import { formatDecimal } from "../../i18n";

/**
 * Числа изменения улучшения для карточки выбора
 * (docs/27-design-system-and-app-shell.md §6).
 */
export interface FormattedChange {
  /** было; `null` — показывать нечего */
  from: string | null;
  to: string;
  /** стало лучше — для цвета; у нового предмета сравнивать не с чем */
  better: boolean | null;
}

export function formatChange(change: UpgradeChange): FormattedChange {
  const render = (value: number): string => formatValue(change.format, value);

  if (change.from === null) {
    return { from: null, to: render(change.to), better: null };
  }
  const grew = change.to > change.from;
  return {
    from: render(change.from),
    to: render(change.to),
    better: change.lowerIsBetter ? !grew : grew,
  };
}

function formatValue(format: UpgradeChange["format"], value: number): string {
  switch (format) {
    case "percent": {
      // Множитель 1.1 — это «+10%», 0.92 — «−8%»: игроку нужен сдвиг, а не коэффициент.
      const percent = Math.round((value - 1) * 100);
      return `${signed(percent)}%`;
    }
    case "plus":
      return signed(value);
    default:
      return formatDecimal(value);
  }
}

/**
 * Знак у нуля не ставится. Минус — типографский «−» явно: Intl в разных
 * движках ставит то дефис, то минус, а рядом с «+» дефис выглядит короче и
 * читается как тире.
 */
function signed(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${formatDecimal(value)}` : `−${formatDecimal(-value)}`;
}
