import type { ReactNode } from "react";
import { t } from "../../i18n";

/**
 * Знак игры v2 (design/art/direction-v2.md §7.1): руна Ж с ромбом-оберегом и
 * словесный знак «РУБЕЖ», в котором та же руна стоит последней буквой.
 * Картинки собирает `design/art/src/logo.mjs` — многоугольники на сетке, а не
 * шрифт, поэтому знак одинаков в игре, в картинках бота и на промо. Та же
 * разметка лежит в index.html заставкой, чтобы переход от заставки к оболочке
 * не мигал.
 *
 * Знак и словесный знак рядом не ставятся: руна в них одна и та же, и пара
 * читалась бы как повтор. Где есть место для имени — словесный знак, где нет
 * (загрузка забега, ворота) — знак.
 */
const RUNE_URL = new URL("../brand/rune.svg", import.meta.url).href;
const WORDMARK_URL = new URL("../brand/wordmark.svg", import.meta.url).href;

/** Пропорции картинок из `logo.mjs`: высота к ширине. */
const RUNE_RATIO = 127 / 124;
const WORDMARK_RATIO = 143 / 454;

export function Emblem(props: { size?: number; animated?: boolean }): ReactNode {
  const size = props.size ?? 72;

  return (
    <span className="relative isolate inline-flex items-center justify-center" style={{ width: size, height: size * RUNE_RATIO }}>
      <span aria-hidden="true" className="halo-accent pointer-events-none absolute -inset-1/4 -z-10 animate-glow rounded-full" />
      <img
        src={RUNE_URL}
        alt=""
        width={size}
        height={Math.round(size * RUNE_RATIO)}
        draggable={false}
        className={props.animated === true ? "animate-float select-none" : "select-none"}
      />
    </span>
  );
}

/** Ширина словесного знака: `l` — заставка, `m` — «Об игре». */
const WORDMARK_WIDTH = { m: 200, l: 288 } as const;

export function Wordmark(props: { size?: "m" | "l" }): ReactNode {
  const width = WORDMARK_WIDTH[props.size ?? "m"];
  return (
    <img
      src={WORDMARK_URL}
      alt={t("app.name")}
      width={width}
      height={Math.round(width * WORDMARK_RATIO)}
      draggable={false}
      className={["h-auto select-none", props.size === "l" ? "landscape:w-[200px]" : ""].join(" ")}
    />
  );
}
