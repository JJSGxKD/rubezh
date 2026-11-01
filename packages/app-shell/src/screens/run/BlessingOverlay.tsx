import { useId, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { BlessingDef, LoadoutStat } from "@bh/shared-types";
import { Card, Modal, RibbonTitle } from "../../design-system/components";
import { formatDecimal, hasTranslation, t } from "../../i18n";
import "../../i18n/arsenal";
import "../../i18n/run";
import { guarded, useTapGuard } from "./overlay-guard";

/**
 * Окно капища «Выбери благословение» (docs/35-stage4-plan.md, Р153,
 * tasks/T-0260): мир стоит, пока игрок не выберет одно из предложенных; окно
 * устроено как выбор улучшения — те же карточки, лента-заголовок и защита от
 * случайного касания. Выбор отдаёт id движку (`chooseBlessing`), и забег идёт
 * дальше; прибавка действует до конца забега.
 */

export interface BlessingOverlayProps {
  options: readonly BlessingDef[];
  onChoose(id: string): void;
}

export interface BlessingCard {
  id: string;
  title: string;
  /** прибавки строками: «Урон +10 %» */
  gains: string[];
  /** выбрать это благословение */
  pick(): void;
}

/** Здоровье, восстановление и броня — числом, остальное — прибавкой в процентах (как у снаряжения). */
const FLAT_STATS: ReadonlySet<string> = new Set(["maxHp", "regenPerSec", "armor"]);

/** Прибавка строкой из модификатора; название параметра — из словаря снаряжения, незнакомое — как есть. */
export function blessingGains(modifiers: Partial<Record<LoadoutStat, number>>): string[] {
  return Object.entries(modifiers).flatMap(([stat, value]) => {
    if (value === undefined) return [];
    const key = `item.stat.${stat}`;
    const name = hasTranslation(key) ? t(key) : stat;
    return [FLAT_STATS.has(stat) ? `${name} +${formatDecimal(value, 1)}` : `${name} +${formatDecimal(value * 100, 1)} %`];
  });
}

/** Карточки по предложению движка, в его порядке. Вынесено из компонента ради теста. */
export function blessingCards(options: readonly BlessingDef[], onChoose: (id: string) => void): BlessingCard[] {
  return options.map((blessing) => ({
    id: blessing.id,
    title: t(blessing.nameKey),
    gains: blessingGains(blessing.modifiers),
    pick: () => onChoose(blessing.id),
  }));
}

export function BlessingOverlay(props: BlessingOverlayProps): ReactNode {
  const ready = useTapGuard();
  const titleId = useId();
  const cards = blessingCards(props.options, props.onChoose);

  return (
    <Modal labelledBy={titleId} icon={<Sparkles size={28} />} size="l" relic="var(--color-info)">
      <div className="mb-2 flex justify-center short:mb-1">
        <RibbonTitle id={titleId} tone="var(--color-info)">
          {t("blessing.title")}
        </RibbonTitle>
      </div>
      <p className="-mt-1 mb-2 text-center text-sm text-text short:hidden">{t("blessing.subtitle")}</p>
      {/* В ландшафте карточки идут в ряд, в портрете — столбцом: как у выбора улучшения. */}
      <div className="grid gap-2 landscape:grid-cols-3">
        {cards.map((card, index) => (
          <Card key={card.id} appearIndex={index} compact stripe="info" onClick={guarded(ready, card.pick)}>
            <span className="block min-w-0 font-display text-base font-bold break-words text-text">{card.title}</span>
            {card.gains.map((gain) => (
              <span key={gain} className="mt-1 block text-sm font-semibold tabular-nums text-success">
                {gain}
              </span>
            ))}
          </Card>
        ))}
      </div>
    </Modal>
  );
}
