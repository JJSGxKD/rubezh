import type { ReactNode } from "react";
import { CloudOff } from "lucide-react";
import { Button } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import type { PlaytestFailure } from "../../state/playtest-api";

/**
 * Общее у рейтинга и профиля: что сказать игроку, когда сервер плейтеста не
 * ответил. Причина разная — и совет разный: «проверь связь» тому, у кого
 * выключена подпись, не поможет.
 */
export function PlaytestProblem(props: { failure: PlaytestFailure; onRetry?: () => void; compact?: boolean }): ReactNode {
  const retryable = props.failure === "offline" || props.failure === "unavailable";

  return (
    <div
      role="status"
      className={[
        "surface-sunken flex items-start gap-3 rounded-lg",
        props.compact === true ? "px-3 py-2.5" : "p-4",
      ].join(" ")}
    >
      <CloudOff size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-muted">{t(`playtest.failure.${props.failure}`)}</p>
        {retryable && props.onRetry !== undefined ? (
          <div className="mt-2">
            <Button variant="secondary" onClick={props.onRetry}>
              {t("app.retry")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Место в таблице: первые три — медалью цвета, остальные — номером. */
export function RankMark(props: { rank: number }): ReactNode {
  const tone =
    props.rank === 1
      ? "bg-elite text-on-accent"
      : props.rank === 2
        ? "bg-text-muted text-bg"
        : props.rank === 3
          ? "bg-warning text-on-accent"
          : "surface-sunken text-text-muted";

  return (
    <span
      className={`inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-pill px-1.5 font-display text-sm font-bold tabular-nums ${tone}`}
    >
      {props.rank}
    </span>
  );
}

/** Время выживания крупно и моноширинно: столбец времён читается сверху вниз. */
export function SurvivalTime(props: { seconds: number; tone?: "accent" }): ReactNode {
  return (
    <span
      className={[
        "font-display text-base font-bold tabular-nums",
        props.tone === "accent" ? "text-accent" : "text-text",
      ].join(" ")}
    >
      {formatDuration(props.seconds)}
    </span>
  );
}
