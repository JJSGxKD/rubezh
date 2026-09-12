import type Phaser from "phaser";

/**
 * Стиль текста на канве.
 *
 * Размер задаётся в игровых единицах и пересчитывается в физические пиксели:
 * канва создаётся в них же, и без пересчёта на экране с высокой плотностью
 * текст выходит мелким и мыльным (docs/25-week1-fps-trials.md §1.4).
 */
export function canvasTextStyle(
  unitScale: number,
  sizeUnits: number,
  color: string,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: "monospace",
    fontSize: `${Math.round(sizeUnits * unitScale)}px`,
    color,
  };
}
