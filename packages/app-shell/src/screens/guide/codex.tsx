import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Card } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/guide";
import "../../i18n/tasks";
import { codexAvailable, createCodexApi, loadCodexState, type CodexReward, type CodexState } from "../../state/codex-api";
import { loadBadges } from "../../state/badges-api";
import { track } from "../../state/shell";
import { claimFailureKey, createTasksApi } from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { enemyGroup, type GuideEnemy } from "./guide-data";

/**
 * Кодекс врагов в гайдбуке (docs/39-retention-mechanics.md К2, tasks/T-0127):
 * полоса «Открыто N из M» над списком врагов и силуэт вместо закрытой записи.
 * Запись открывает встреча с врагом в забеге — считает сервер. Награда за
 * полный кодекс — достижение каталога, забор тот же, что на экране заданий.
 *
 * Справочник не должен ломаться оттого, что кодекс не загрузился: гость, ошибка
 * сети и старый сервер дают список как раньше, со строкой пояснения.
 */

const codexApi = createCodexApi();
const tasksApi = createTasksApi();

export interface CodexControl {
  state: CodexState;
  claiming: boolean;
  /** отказ забора — текст для строки под полосой */
  notice: string | null;
  claim(): void;
}

/** Загружает кодекс при открытии вкладки «Враги» и держит забор награды. */
export function useCodex(): CodexControl {
  const [state, setState] = useState<CodexState>({ status: "loading" });
  const [claiming, setClaiming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadCodexState(codexApi, codexAvailable()).then((next) => {
      if (!alive) return;
      setState(next);
      if (next.status === "ready") {
        const { reward } = next.view;
        track("codex_viewed", { opened: next.view.opened.length, total: next.view.total, claimable: reward !== null && reward.done && !reward.claimed });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const claim = useCallback((): void => {
    if (state.status !== "ready" || state.view.reward === null || claiming) return;
    const reward = state.view.reward;
    setClaiming(true);
    setNotice(null);
    void tasksApi.claim(reward.taskId).then(async (response) => {
      if (!response.ok) {
        setClaiming(false);
        setNotice(t(claimFailureKey(response.code)));
        return;
      }
      if (response.data.claimed) {
        track("achievement_unlocked", { achievement: reward.taskId, kind: "codex_percent", category: "collection", prestige: reward.prestige });
        void loadWallet();
      }
      void loadBadges();
      // Награда забрана — ответ кодекса перечитывается, чтобы кнопка сменилась подписью.
      const next = await loadCodexState(codexApi, codexAvailable());
      setClaiming(false);
      if (next.status === "ready") setState(next);
    });
  }, [state, claiming]);

  return { state, claiming, notice, claim };
}

/** Полоса «Открыто N из M» и награда за полный кодекс. */
export function CodexBar(props: { opened: number; total: number; reward: CodexReward | null; claiming?: boolean; notice?: string | null; onClaim: () => void }): ReactNode {
  const { reward } = props;
  const progress = t("guide.codex.progress", { opened: props.opened, total: props.total });

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-bold text-text">{t("guide.codex.title")}</h2>
        <span className="shrink-0 font-display text-sm tabular-nums text-text-muted">{progress}</span>
      </div>
      {/* Родной <progress>: значение читают и скринридеры, а раскраска — токенами. */}
      <progress
        value={props.opened}
        max={Math.max(props.total, 1)}
        aria-label={progress}
        className={[
          "mt-2 block h-2.5 w-full appearance-none overflow-hidden rounded-pill bg-surface-sunken",
          "[&::-webkit-progress-bar]:bg-surface-sunken [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent",
        ].join(" ")}
      />
      {reward === null ? null : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-text-muted">{t("guide.codex.reward", { coins: reward.coins, prestige: reward.prestige })}</p>
          {reward.claimed ? (
            <Badge tone="accent">{t("guide.codex.claimed")}</Badge>
          ) : reward.done ? (
            <Button track="claim_codex" size="s" loading={props.claiming === true} onClick={props.onClaim}>
              {t("guide.codex.claim")}
            </Button>
          ) : null}
        </div>
      )}
      {props.notice === null || props.notice === undefined ? null : <p className="mt-2 text-xs font-semibold text-text-muted">{props.notice}</p>}
    </Card>
  );
}

/** Над списком врагов: заглушка на загрузке, полоса при ответе, строка пояснения без него. */
export function CodexHeader(props: { codex: CodexControl }): ReactNode {
  const { state } = props.codex;
  if (state.status === "loading") {
    return <div aria-hidden="true" className="surface-sunken h-24 rounded-md" />;
  }
  if (state.status === "ready") {
    const { view } = state;
    return <CodexBar opened={view.opened.length} total={view.total} reward={view.reward} claiming={props.codex.claiming} notice={props.codex.notice} onClaim={props.codex.claim} />;
  }
  return <p className="text-xs text-text-muted">{t("guide.codex.error")}</p>;
}

/**
 * Закрытая запись: нейтральный силуэт, «Неизвестный враг» и группа — рядовой,
 * элита или босс. Названия, формы поведения и описания нет вовсе: игрок знает,
 * кого искать, но не кто это.
 */
export function LockedEnemyCard(props: { enemy: GuideEnemy; index: number }): ReactNode {
  const group = enemyGroup(props.enemy.def);
  const big = group !== "regular";
  const name = t("guide.codex.locked.name");

  return (
    <Card appearIndex={Math.min(props.index, 6)}>
      <div className="flex items-center gap-3">
        <svg role="img" aria-label={name} viewBox="0 0 64 64" className="size-16 shrink-0 text-border-strong">
          <circle cx="32" cy="32" r={big ? 26 : 18} fill="currentColor" opacity={0.35} />
          {big ? <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" /> : null}
          <text x="32" y="40" textAnchor="middle" fontSize="24" fontWeight="700" fill="currentColor">
            ?
          </text>
        </svg>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-display text-base font-bold text-text">{name}</h3>
            <Badge tone={big ? "warning" : "muted"}>{t(`guide.codex.group.${group}`)}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-muted">{t("guide.codex.locked.hint")}</p>
        </div>
      </div>
    </Card>
  );
}
