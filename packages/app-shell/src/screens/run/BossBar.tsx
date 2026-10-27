import type { ReactNode } from "react";
import type { BossSnapshot } from "@bh/core-game";
import { ProgressBar } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";

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

  // Облик v2 (design/art/direction-v2.md §4.4): босс — событие, и полоса
  // говорит языком окон наград — ромб и кайма-оберег тоном элиты у имени,
  // ромбы-наконечники у полосы, деления фаз — зарубками-ромбами. Всё
  // украшение статично: React перерисовывает полосу только с её числом.
  return (
    <div className="mx-auto w-full max-w-[420px] px-6 pt-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rotate-45 bg-elite" />
        <span className="min-w-0 truncate font-display text-xs font-bold tracking-wide text-elite uppercase">{name}</span>
        <span aria-hidden="true" className="section-rule h-2.5 min-w-4 flex-1" style={{ background: "linear-gradient(90deg, var(--color-elite), transparent)" }} />
        <span className="shrink-0 font-display text-xs font-bold tabular-nums text-text-muted">
          {t("run.boss.phase", { phase: boss.phase + 1, phases: boss.phases })}
        </span>
      </div>
      <div className="relative mt-1.5">
        <ProgressBar value={boss.hp} max={boss.maxHp} tone="boss" height="thick" label={name} />
        {/* Деления фаз поверх полосы: где босс станет злее, видно заранее. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {Array.from({ length: boss.phases - 1 }, (_, index) => (
            <span
              key={index}
              className="absolute inset-y-0 border-r border-bg/70"
              style={{ left: `${String(((index + 1) * 100) / boss.phases)}%` }}
            >
              <span className="absolute -top-1 -left-1 size-2 rotate-45 bg-bg ring-1 ring-elite/80" />
            </span>
          ))}
        </div>
        <span aria-hidden="true" className="absolute top-1/2 -left-2 size-3 -translate-y-1/2 rotate-45 bg-elite ring-2 ring-bg" />
        <span aria-hidden="true" className="absolute top-1/2 -right-2 size-3 -translate-y-1/2 rotate-45 bg-elite ring-2 ring-bg" />
      </div>
    </div>
  );
}
