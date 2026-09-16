import type { ReactNode } from "react";
import { Skull } from "lucide-react";
import type { BossSnapshot } from "@bh/core-game";
import { ProgressBar } from "../../design-system/components";
import { t } from "../../i18n";

/**
 * Полоса здоровья босса: имя, остаток и фаза боя
 * (docs/27-design-system-and-app-shell.md §3.3).
 *
 * Только у босса, не у элиты: элит за забег приходят десятки, и полоса на
 * каждую стала бы фоном. Бой с боссом — отдельное событие забега, и игрок
 * должен видеть, сколько осталось и когда тот станет злее.
 *
 * Деления на полосе — это фазы: перейдённый порог меняет и полосу, и
 * поведение босса, поэтому игрок связывает одно с другим сам.
 */
export function BossBar(props: { boss: BossSnapshot }): ReactNode {
  const { boss } = props;
  const name = t(`enemy.${boss.enemyId}.name`);

  return (
    <div className="mx-auto w-full max-w-[420px] px-4 pt-2">
      <div className="flex items-center gap-2">
        <Skull size={16} aria-hidden="true" className="shrink-0 text-elite" />
        <span className="min-w-0 truncate font-display text-xs font-bold tracking-wide text-elite uppercase">{name}</span>
        <span className="ml-auto shrink-0 font-display text-xs font-bold tabular-nums text-text-muted">
          {t("run.boss.phase", { phase: boss.phase + 1, phases: boss.phases })}
        </span>
      </div>
      <div className="relative mt-1">
        <ProgressBar value={boss.hp} max={boss.maxHp} tone="boss" height="thick" label={name} />
        {/* Деления фаз поверх полосы: где босс станет злее, видно заранее. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex">
          {Array.from({ length: boss.phases - 1 }, (_, index) => (
            <span
              key={index}
              className="h-full border-r border-bg/70"
              style={{ width: `${100 / boss.phases}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
