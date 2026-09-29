import type { ReactNode } from "react";
import { formatNumber, t } from "../../i18n";
import "../../i18n/account";
import type { ProgressView } from "../../state/progress";

/**
 * Уровень аккаунта (docs/35-stage4-plan.md, WP4): сколько набрано внутри
 * уровня и что даст следующий — чтобы уровень был целью, а не цифрой. Общий
 * для профиля и экрана уровня.
 */
export function AccountLevel(props: { progress: ProgressView }): ReactNode {
  const { progress } = props;
  const share = progress.xpForNext === null || progress.xpForNext === 0 ? 1 : Math.min(1, progress.xpIntoLevel / progress.xpForNext);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-sm font-bold text-text">{t("profile.level", { level: progress.level })}</span>
        <span className="text-xs tabular-nums text-text-muted">
          {progress.xpForNext === null
            ? t("profile.level.max")
            : t("profile.level.xp", { current: formatNumber(progress.xpIntoLevel), next: formatNumber(progress.xpForNext) })}
        </span>
      </div>
      <span className="surface-sunken mt-1.5 block h-2 overflow-hidden rounded-pill">
        <span className="fill-xp block h-full origin-left rounded-pill" style={{ transform: `scaleX(${share})` }} />
      </span>
      {progress.nextReward === null ? null : (
        <p className="mt-1.5 text-xs text-text-muted">
          {progress.nextReward.gems > 0
            ? t("profile.level.nextRewardGems", { coins: formatNumber(progress.nextReward.coins), gems: progress.nextReward.gems })
            : t("profile.level.nextReward", { coins: formatNumber(progress.nextReward.coins) })}
        </p>
      )}
    </div>
  );
}
