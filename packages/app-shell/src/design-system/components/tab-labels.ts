/** Запас по бокам подписи внутри вкладки, px: подпись не должна касаться соседней. */
export const TAB_LABEL_GAP_PX = 4;

/** `all` — подписи у всех вкладок; `active` — только у активной. */
export type TabLabelMode = "all" | "active";

/**
 * Режим подписей нижней панели по измерению, а не по порогу ширины: шрифт
 * сменится, появится другой язык, и порог в пикселях соврал бы.
 *
 * Ширины — по вкладкам в одном порядке: `labelWidths[i]` — естественная
 * ширина подписи i-й вкладки (`scrollWidth`), `tabWidths[i]` — ширина её
 * кнопки (`clientWidth`). Нулевая ширина вкладки — панель ещё не разложена
 * или скрыта: мерить нечего, остаётся безопасный режим.
 */
export function tabLabelMode(labelWidths: readonly number[], tabWidths: readonly number[]): TabLabelMode {
  if (labelWidths.length === 0 || labelWidths.length !== tabWidths.length) return "active";
  const fits = labelWidths.every((label, index) => {
    const tab = tabWidths[index] ?? 0;
    return tab > 0 && label + 2 * TAB_LABEL_GAP_PX <= tab;
  });
  return fits ? "all" : "active";
}
