/**
 * Правила раскладки для ПК (tasks/T-0298, docs/27-design-system-and-app-shell.md
 * §5.3). Чистые функции без React: класс ширины решает, что рисует оболочка,
 * и это проверяется тестом, а не глазами на трёх размерах окна.
 *
 * Числа дублируют токены `--rail-width`, `--aside-width`, `--wide-column` и
 * `--side-panel-width` из `tokens.css`: CSS их читает, правила — сравнивают, а
 * тест следит, чтобы они не разошлись.
 */

/** С какой ширины окна раскладка для ПК, CSS px. Окно Mini App в Telegram Desktop бывает уже монитора, поэтому — ширина окна, а не устройство. */
export const WIDE_MIN_WIDTH_PX = 1024;

export const WIDE_MEDIA_QUERY = `(min-width: ${String(WIDE_MIN_WIDTH_PX)}px)`;

/** Боковое меню. */
export const RAIL_WIDTH_PX = 232;

/** Вторая колонка экрана. */
export const ASIDE_WIDTH_PX = 380;

/** Колонка контента на wide вместо 480 px телефона. */
export const WIDE_COLUMN_PX = 1120;

/** Лист, открытый панелью сбоку. */
export const SIDE_PANEL_WIDTH_PX = 420;

export function isWideWidth(widthPx: number): boolean {
  return widthPx >= WIDE_MIN_WIDTH_PX;
}

export type ScreenColumns = "single" | "split";

/** Две колонки — только на wide и только если экран отдал `aside`; иначе `aside` идёт под основным. */
export function screenColumns(input: { wide: boolean; hasAside: boolean }): ScreenColumns {
  return input.wide && input.hasAside ? "split" : "single";
}

/** Колонка контента: телефонная 480 px или широкая из токена. */
export function contentColumnClass(wide: boolean): string {
  return wide ? "mx-auto w-full max-w-(--wide-column)" : "mx-auto w-full max-w-[480px]";
}

export type ModalPlacement = "center" | "bottom" | "side";

/** Лист снизу на wide открывается панелью справа; центральные модалки не меняются. */
export function modalPlacementOn(placement: "center" | "bottom" | undefined, wide: boolean): ModalPlacement {
  if (placement === "bottom") return wide ? "side" : "bottom";
  return "center";
}

export interface Chrome {
  /** чем переключаются разделы */
  nav: "rail" | "tabs" | "none";
  /** шапка: с кошельком в потоке (wide), стеклом поверх прокрутки (телефон) или без */
  header: "wide" | "app" | "none";
}

/**
 * Что оболочка рисует вокруг экрана. Забег и экраны вне разделов — без меню и
 * шапки на любой ширине. На телефоне нижняя панель и шапка — только у корня
 * раздела; на wide боковое меню остаётся и на экране, открытом из раздела
 * (у такого экрана своя верхняя панель с «назад»), а шапка с кошельком — у
 * корня.
 */
export function chromeFor(input: { wide: boolean; inRun: boolean; tabRoot: boolean; depth: number }): Chrome {
  if (input.inRun || !input.tabRoot) return { nav: "none", header: "none" };
  const root = input.depth === 1;
  if (input.wide) return { nav: "rail", header: root ? "wide" : "none" };
  return root ? { nav: "tabs", header: "app" } : { nav: "none", header: "none" };
}
