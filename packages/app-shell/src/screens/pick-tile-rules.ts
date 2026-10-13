/**
 * Значок выбора лежит внутри плитки, в её правом верхнем углу, и повторяет
 * контур плитки (`rounded-lg`): всё, что выходит за правый край
 * прокручиваемого листа, даёт ему горизонтальную полосу. Высота 14 px — чтобы
 * на 320 px уголок не наезжал на цену буста в первой строке плитки.
 */
export const SELECTED_MARK_CLASS =
  "absolute top-0 right-0 inline-flex size-3.5 items-center justify-center rounded-tr-lg rounded-bl-md bg-accent text-on-accent";

const OUTSIDE_OFFSET = /^-(?:top|right|bottom|left|start|end|inset(?:-[xy])?)-/;
const OUTSIDE_TRANSLATE = /^-translate-[xy]-/;

/**
 * Выносит ли набор классов элемент за границу родителя: `-top-1.5`, `-right-1`,
 * `-inset-x-1`, `-translate-x-1/2`. Отрицательные отступы (`-mx-1`) не в счёт:
 * они двигают контейнер, а не значок за его край.
 */
export function hasOutsideOffset(classes: string): boolean {
  return classes
    .split(/\s+/)
    .map((token) => token.slice(token.lastIndexOf(":") + 1))
    .some((token) => OUTSIDE_OFFSET.test(token) || OUTSIDE_TRANSLATE.test(token));
}
