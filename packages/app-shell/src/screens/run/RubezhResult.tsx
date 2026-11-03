import type { ReactNode } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { RunResult } from "@bh/shared-types";
import { Badge } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import "../../i18n/run";
import type { RunRewardView } from "../../state/progress";

/**
 * Рубеж на экране смерти (tasks/T-0124, Р102, Р105): над блоком «Что дальше»,
 * под уровнем. Победа над стражем — карточка «Рубеж взят» со временем; страж
 * пришёл, но жив, — строка с остатком его здоровья; не дошёл — ничего.
 *
 * Рубеж показывается по итогу забега, он считан на устройстве и есть без сети
 * и у гостя. Строка «Награда ×N» — только когда её подтвердил ответ сервера
 * (`rubezhMul`): оболочка множитель сама не выводит и не обещает.
 */
export type RubezhResultView =
  | { kind: "cleared"; clearedSec: number; rewardMul: number | null }
  | { kind: "stopped"; guardHpPercent: number | null };

export function rubezhResultView(result: RunResult, reward: RunRewardView | undefined): RubezhResultView | null {
  const rubezh = result.rubezh;
  if (rubezh === undefined || !rubezh.reached) return null;
  if (rubezh.clearedSec !== null) {
    // Множитель не больше единицы награды не прибавляет: «×1» ничего не обещает, строку не рисуем.
    const mul = reward?.status === "granted" ? (reward.rubezhMul ?? null) : null;
    return { kind: "cleared", clearedSec: rubezh.clearedSec, rewardMul: mul !== null && mul > 1 ? mul : null };
  }
  return { kind: "stopped", guardHpPercent: rubezh.guardHpPercent };
}

export function RubezhResult(props: { result: RunResult; reward: RunRewardView | undefined }): ReactNode {
  const view = rubezhResultView(props.result, props.reward);
  if (view === null) return null;

  if (view.kind === "stopped") {
    return (
      <div className="flex animate-pop-in items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5">
        <ShieldAlert size={18} aria-hidden="true" className="shrink-0 text-elite" />
        <p className="min-w-0 text-[13px] leading-snug text-text">
          {view.guardHpPercent === null ? t("run.rubezh.stopped.plain") : t("run.rubezh.stopped", { percent: view.guardHpPercent })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex animate-pop-in items-center gap-2.5 rounded-lg border border-elite/45 bg-gradient-to-br from-elite/14 to-surface px-3 py-2.5">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-elite/15 text-elite">
        <ShieldCheck size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[15px] leading-tight text-elite">{t("run.rubezh.cleared.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-text">{t("run.rubezh.cleared.time", { time: formatDuration(view.clearedSec) })}</div>
        {/* Награда приходит позже итога: метка появляется вместе с ней, а карточка видна сразу.
            Под временем, а не сбоку: рядом на 320 px она сжимала заголовок до двух строк. */}
        {view.rewardMul === null ? null : (
          <span className="mt-1.5 inline-block animate-pop-in">
            <Badge tone="accent">{t("run.rubezh.cleared.reward", { mul: view.rewardMul })}</Badge>
          </span>
        )}
      </div>
    </div>
  );
}
