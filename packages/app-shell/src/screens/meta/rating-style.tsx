import { useEffect, useState, type ReactNode } from "react";
import { Card, SectionTitle } from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";
import "../../i18n/season";
import { track } from "../../state/shell";
import { createStyleApi, type StyleSummary } from "../../state/seasons-api";
import { GameGlyph, STYLE_GLYPHS } from "../game-glyphs";
import {
  divisionShare,
  hintKey,
  styleAxis,
  type DivisionId,
  type Scoring,
  type StyleAxis,
} from "./rating-rules";

/**
 * Стиль и дивизион игрока на экране рейтинга (tasks/T-0296, Р152): значок
 * стиля у имени, плашка дивизиона сезона и блок «Твой стиль» с подсказкой к
 * слабой оси. Числа и оси считает сервер (T-0295); здесь — только показ.
 */

/** Тон значка каждой оси: те же, что у осей на макете (design/art/mockups/rating-v2.html). */
const STYLE_TONE: Readonly<Record<StyleAxis, string>> = {
  t: "[--badge-tone:var(--color-secondary)]",
  k: "[--badge-tone:var(--color-accent)]",
  h: "[--badge-tone:var(--color-elite)]",
  c: "[--badge-tone:var(--color-info)]",
  b: "[--badge-tone:var(--color-passive)]",
};

/** Цвет слова оси в блоке «Твой стиль» — тот же тон, что у значка. */
const AXIS_TEXT: Readonly<Record<StyleAxis, string>> = {
  t: "text-secondary",
  k: "text-accent",
  h: "text-elite",
  c: "text-info",
  b: "text-passive",
};

/** Значок стиля: знак оси и её слово. Плашка непрозрачная, как у остальных тонов (docs/27 §4.2). */
export function StyleBadge(props: { axis: StyleAxis; large?: boolean }): ReactNode {
  return (
    <span
      className={[
        "badge-tinted inline-flex shrink-0 items-center gap-1 rounded-sm font-display font-semibold whitespace-nowrap",
        props.large === true ? "px-2 py-1 text-sm" : "px-1.5 py-0.5 text-xs",
        STYLE_TONE[props.axis],
      ].join(" ")}
    >
      <GameGlyph glyph={STYLE_GLYPHS[props.axis]} size={props.large === true ? 18 : 13} />
      {t(`rating.style.${props.axis}`)}
    </span>
  );
}

/** Тон плашки дивизиона — токены `--division-*` (design-system/tokens.css). */
const DIVISION_TONE: Readonly<Record<DivisionId, string>> = {
  ruby: "[--badge-tone:var(--division-ruby)]",
  gold: "[--badge-tone:var(--division-gold)]",
  silver: "[--badge-tone:var(--division-silver)]",
  bronze: "[--badge-tone:var(--division-bronze)]",
};

const DIVISION_TEXT: Readonly<Record<DivisionId, string>> = {
  ruby: "text-(color:--division-ruby)",
  gold: "text-(color:--division-gold)",
  silver: "text-(color:--division-silver)",
  bronze: "text-(color:--division-bronze)",
};

export function DivisionBadge(props: { division: DivisionId }): ReactNode {
  return (
    <span className={`badge-tinted inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 font-display text-xs font-semibold whitespace-nowrap ${DIVISION_TONE[props.division]}`}>
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {t(`rating.division.${props.division}`)}
    </span>
  );
}

/** Название дивизиона словом с маленькой буквы, цветом тона: «… · серебро» в строке «Ты». */
export function DivisionWord(props: { division: DivisionId }): ReactNode {
  return <span className={`font-semibold ${DIVISION_TEXT[props.division]}`}>{t(`rating.division.${props.division}`).toLowerCase()}</span>;
}

/** Результат сравнения с границей дивизиона, если она известна. */
export interface DivisionGap {
  next: DivisionId;
  gap: number;
  unit: Scoring;
}

/**
 * Плашка дивизиона в сезоне: «Ты — серебро · топ-35% сезона · лучший забег
 * 4 205» и, когда известна граница, «серебро → золото: 610 очков».
 */
export function DivisionPlaque(props: { division: DivisionId; best: { kind: Scoring; value: number } | null; next: DivisionGap | null }): ReactNode {
  const share = divisionShare(props.division);
  const parts = [
    share === null ? t("rating.plaque.all") : t("rating.plaque.share", { share }),
    ...(props.best === null ? [] : [t("rating.plaque.best", { value: props.best.kind === "points" ? formatNumber(props.best.value) : formatDuration(props.best.value) })]),
  ];
  const next = props.next;

  return (
    <div className="surface-card rounded-lg p-3">
      <p className={`font-display text-base font-bold ${DIVISION_TEXT[props.division]}`}>
        {t("rating.plaque.title", { division: t(`rating.division.${props.division}`).toLowerCase() })}
      </p>
      <p className="mt-0.5 text-xs text-text-muted">{parts.join(" · ")}</p>
      {next === null ? null : (
        <p className="mt-1.5 text-sm text-text">
          {next.unit === "points"
            ? t("rating.plaque.next", {
                from: t(`rating.division.${props.division}`).toLowerCase(),
                to: t(`rating.division.${next.next}`).toLowerCase(),
                shown: formatNumber(next.gap),
                n: next.gap,
              })
            : t("rating.plaque.nextTime", {
                from: t(`rating.division.${props.division}`).toLowerCase(),
                to: t(`rating.division.${next.next}`).toLowerCase(),
                time: formatDuration(next.gap),
              })}
        </p>
      )}
    </div>
  );
}

/**
 * Карточка «Твой стиль»: стиль, сильная и слабая ось и подсказка, что поднимет
 * слабую. Забегов меньше трёх — сколько сыграть ещё, без осей.
 */
export function StyleCard(props: { summary: StyleSummary }): ReactNode {
  const { summary } = props;
  const strong = styleAxis(summary.strong);
  const weak = styleAxis(summary.weak);
  const style = styleAxis(summary.style);
  const ready = summary.missing === 0 && style !== null;

  return (
    <Card>
      <SectionTitle as="h3" spacing="mb-2">
        {t("rating.style.title")}
      </SectionTitle>
      {!ready ? (
        <p className="text-sm text-text-muted">{t("rating.style.more", { n: Math.max(1, summary.missing) })}</p>
      ) : (
        <>
          <div className="flex">
            <StyleBadge axis={style} large />
          </div>
          <dl className="mt-3 grid gap-2">
            {strong === null ? null : (
              <div>
                <dt className="text-xs text-text-muted">{t("rating.style.strong")}</dt>
                <dd className={`font-display text-sm font-bold ${AXIS_TEXT[strong]}`}>{t(`rating.axis.${strong}`)}</dd>
              </div>
            )}
            {weak === null ? null : (
              <div>
                <dt className="text-xs text-text-muted">{t("rating.style.weak")}</dt>
                <dd className={`font-display text-sm font-bold ${AXIS_TEXT[weak]}`}>{t(`rating.axis.${weak}`)}</dd>
              </div>
            )}
          </dl>
          {weak === null ? null : <p className="mt-3 text-sm text-text-muted">{t(hintKey(weak))}</p>}
        </>
      )}
    </Card>
  );
}

const styleApi = createStyleApi();

/**
 * «Твой стиль» в сезоне. Ответ не пришёл — блока нет: это подсказка, а не
 * то, без чего вкладка не работает, ошибка здесь только шумела бы. Событие
 * `rating_style_opened` — когда блок показан с ответом сервера, раз за открытие.
 */
export function StyleBlock(): ReactNode {
  const [summary, setSummary] = useState<StyleSummary | null>(null);

  useEffect(() => {
    let current = true;
    void styleApi.myStyle().then((response) => {
      if (!current || !response.ok) return;
      setSummary(response.data);
      track("rating_style_opened");
    });
    return () => {
      current = false;
    };
  }, []);

  return summary === null ? null : <StyleCard summary={summary} />;
}
