import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Medal, Shield, Trophy } from "lucide-react";
import type { PublicEmblemView } from "../../state/public-emblem";
import { GameGlyph } from "../game-glyphs";
import { EMBLEM_GLYPHS } from "./emblem-glyphs";
import { EMBLEM_FIT_MIN_WIDTH, emblemFit, emblemInk, emblemLabel, emblemTone, type EmblemFit } from "./emblem-rules";

/**
 * Знак у имени (tasks/T-0236, docs/35-stage4-plan.md Р149): значок и название
 * тоном редкости. Один чип на профиль, рейтинг, сезон и друзей — отличается
 * размером. Закрытый знак — силуэт: значок и название в `text-muted`, без тона.
 * Цвета — только токены: тон приходит переменной, фон и обводка — доли тона.
 */

/** Что чипу нужно знать о знаке: строка списка и строка раздела отдают это же. */
export type EmblemLook = Pick<PublicEmblemView, "id" | "title" | "tier"> & { category: string; season?: number | undefined };

/** Нет значка в карте — значок группы: так знак новее клиента не остаётся пустотой. */
const FALLBACK = { status: Shield, season: Trophy, merit: Medal } as const;

const SIZES = {
  s: { box: "gap-[3px] px-1.5 py-px text-[10.5px]", glyph: 12 },
  l: { box: "gap-1 px-2 py-0.5 text-[12px]", glyph: 14 },
} as const;

/** Значок знака: из карты дизайнера, иначе — значок группы. */
export function EmblemGlyph(props: { id: string; category: string; size: number }): ReactNode {
  const glyph = EMBLEM_GLYPHS[props.id];
  if (glyph !== undefined) return <GameGlyph glyph={glyph} size={props.size} />;
  const Icon = props.category === "status" ? FALLBACK.status : props.category === "season" ? FALLBACK.season : FALLBACK.merit;
  return <Icon size={props.size} aria-hidden="true" />;
}

const FIT_QUERY = `(min-width: ${String(EMBLEM_FIT_MIN_WIDTH)}px)`;

function subscribeFit(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(FIT_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const fitNow = (): EmblemFit => (typeof window === "undefined" ? "full" : emblemFit(window.innerWidth));

/**
 * Как рисовать знак в списке по ширине экрана. Слежение — за границей порога,
 * а не за каждым пикселем ресайза: строки списка не перерисовываются зря.
 */
export function useEmblemFit(): EmblemFit {
  return useSyncExternalStore(subscribeFit, fitNow, () => "full");
}

export interface EmblemChipProps {
  emblem: EmblemLook;
  /** `s` — строка списка, `l` — профиль и раздел */
  size?: "s" | "l";
  /** по умолчанию — по ширине экрана (`emblemFit`); значок без названия получает имя для диктора */
  fit?: EmblemFit;
  /** закрытый знак: силуэт без тона */
  closed?: boolean;
}

export function EmblemChip(props: EmblemChipProps): ReactNode {
  const autoFit = useEmblemFit();
  const fit = props.fit ?? autoFit;
  const size = SIZES[props.size ?? "s"];
  const label = emblemLabel(props.emblem);
  const glyph = <EmblemGlyph id={props.emblem.id} category={props.emblem.category} size={size.glyph} />;
  const nameless = fit === "glyph";
  const common = ["inline-flex min-w-0 max-w-full shrink-0 items-center rounded-sm font-display", size.box].join(" ");
  const a11y = nameless ? ({ role: "img", "aria-label": label } as const) : {};

  if (props.closed === true) {
    return (
      <span className={`${common} surface-sunken text-text-muted ring-1 ring-border`} {...a11y}>
        {glyph}
        {nameless ? null : <span className="truncate">{label}</span>}
      </span>
    );
  }

  const style = {
    "--emblem-tone": emblemTone(props.emblem.tier),
    "--emblem-ink": emblemInk(props.emblem.tier),
    backgroundColor: "color-mix(in oklab, var(--emblem-tone) 15%, transparent)",
    boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--emblem-tone) 45%, transparent)",
  } as CSSProperties;
  return (
    <span className={`${common} text-text`} style={style} {...a11y}>
      <span className="inline-flex shrink-0" style={{ color: "var(--emblem-ink)" }}>
        {glyph}
      </span>
      {nameless ? null : <span className="truncate">{label}</span>}
    </span>
  );
}
