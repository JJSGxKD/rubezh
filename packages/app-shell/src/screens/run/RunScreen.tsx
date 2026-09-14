import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_MAP_ID, type RunInspection } from "@bh/core-game";
import { ErrorState } from "../../design-system/components";
import { t } from "../../i18n";
import { useDevMode } from "../../state/dev-mode";
import { useDiagnostics } from "../../state/diagnostics";
import { useMeta } from "../../state/meta";
import { useNavigation } from "../../state/navigation";
import { usePlatform } from "../../state/platform";
import { usePlaytest } from "../../state/playtest";
import { useRun } from "../../state/run";
import { useShell } from "../../state/shell";
import { RunHud } from "./RunHud";
import { RunLoading } from "./RunLoading";
import { DeathOverlay, LevelUpOverlay, PauseOverlay } from "./overlays";
import { DevSheetLazy } from "./dev-sheet-lazy";
import { DevTechPanelLazy } from "./dev-tech-panel-lazy";
import { RunStatsSheet } from "./RunStatsSheet";

/**
 * Экран забега: канва Phaser на весь экран, HUD слоем поверх и оверлеи
 * паузы, выбора улучшения и смерти.
 *
 * Канва — единственное, что рисует движок; всё остальное здесь React
 * (docs/27-design-system-and-app-shell.md §3.2).
 */
export function RunScreen(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const run = useRun();
  const navigation = useNavigation();
  const diagnostics = useDiagnostics((state) => state.enabled);
  const isActive = usePlatform((state) => state.isActive);
  const submitted = usePlaytest((state) => state.lastSubmitted);
  const [stats, setStats] = useState<RunInspection | null>(null);
  const openStats = (): void => setStats(useRun.getState().inspect());
  const [devOpen, setDevOpen] = useState(false);
  const fpsOverlay = useDiagnostics((state) => state.enabled && state.fpsOverlay);
  const countInRating = useDevMode((state) => state.settings.countInRating);
  const devTechInfo = useDevMode((state) => state.settings.visuals.techInfo);
  // Лист разработчика открывается на паузе: команды «Мира» и шаг по тикам
  // рассчитаны на стоящий мир, а бегущий забег под листом убил бы игрока.
  const openDev = (): void => {
    useRun.getState().pause("manual");
    setDevOpen(true);
  };
  // Оружие для экрана загрузки фиксируется при входе: у продолженного забега
  // оно своё, а ожидание старта движок снимает сразу, как только начал.
  const [weaponId] = useState(
    () => useRun.getState().pendingResume?.startingWeaponId ?? useMeta.getState().lastWeaponId,
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Оружие читается разово из стора, а не из подписки: смена запомненного
    // выбора посреди забега не должна его перезапускать.
    const resume = useRun.getState().pendingResume;
    void useRun.getState().start({
      container,
      startingWeaponId: resume?.startingWeaponId ?? useMeta.getState().lastWeaponId,
      mapId: resume?.mapId ?? DEFAULT_MAP_ID,
      difficultyId: resume?.difficultyId ?? useMeta.getState().lastDifficultyId,
      ...(resume === null ? {} : { resume }),
    });

    // Уход с экрана уносит с собой и движок: чанк остаётся загруженным, а
    // канва и слушатели — нет.
    return () => useRun.getState().stop();
  }, []);

  /**
   * Автопауза при сворачивании. Игрок, которому позвонили, не должен
   * вернуться к экрану смерти: пока приложение в фоне, кадры не идут, а
   * враги — идут.
   */
  useEffect(() => {
    if (isActive) return;
    useRun.getState().pause("app_inactive");
  }, [isActive]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" style={{ zIndex: "var(--z-canvas)" }} />

      <RunLoading stage={run.phase === "error" ? null : run.loadingStage} weaponId={weaponId} />

      {run.hud === null || run.phase === "finished" ? null : (
        <RunHud
          hud={run.hud}
          onPause={() => useRun.getState().pause("manual")}
          {...(run.devRun ? { onDev: openDev } : {})}
        />
      )}

      {run.devInfo !== null && run.phase !== "finished" && (run.devRun ? devTechInfo : fpsOverlay) ? (
        <DevTechPanelLazy info={run.devInfo} compact={!run.devRun} />
      ) : null}

      {run.phase === "paused" && !devOpen ? (
        <PauseOverlay
          elapsedSec={run.hud?.survivalSec ?? 0}
          restored={run.pauseReason === "restored"}
          onResume={() => useRun.getState().resume()}
          onSettings={() => navigation.push("settings")}
          onSurrender={() => useRun.getState().surrender()}
          onStats={openStats}
          {...(run.devRun ? { onDev: () => setDevOpen(true) } : {})}
        />
      ) : null}

      {devOpen && run.devRun && (run.phase === "paused" || run.phase === "levelUp") ? (
        <DevSheetLazy inRun onClose={() => setDevOpen(false)} />
      ) : null}

      {run.phase === "levelUp" ? (
        <LevelUpOverlay
          level={run.level}
          offers={run.offers}
          queued={run.queued}
          {...(run.hud === null ? {} : { loadout: run.hud })}
          onChoose={(optionId) => useRun.getState().choose(optionId)}
          onStats={openStats}
        />
      ) : null}

      {/* Лист закрывается сам, если мир снова пошёл: характеристики — снимок
          стоящего мира, над бегущим они врали бы. */}
      {stats !== null && (run.phase === "paused" || run.phase === "levelUp") ? (
        <RunStatsSheet inspection={stats} onClose={() => setStats(null)} />
      ) : null}

      {run.phase === "finished" && run.result !== null ? (
        <DeathOverlay
          result={run.result}
          isNewRecord={run.isNewRecord}
          rank={submitted?.runId === run.result.runId ? submitted.result.rank : null}
          diagnostics={diagnostics}
          cheatsCounted={run.devRun && countInRating}
          onRestart={() => useRun.getState().restart()}
          onMenu={() => navigation.resetTo("lobby")}
          onShare={() => shareRun()}
        />
      ) : null}

      {run.phase === "error" ? (
        <div className="absolute inset-0 bg-bg" style={{ zIndex: "var(--z-modal)" }}>
          <ErrorState
            text={t(run.errorMessage ?? "error.engine")}
            onRetry={() => navigation.resetTo("lobby")}
          />
        </div>
      ) : null}
    </div>
  );
}


/**
 * Шеринг результата — заглушка этапа 2: адаптер о нём знает, но экрана и
 * картинки ещё нет (docs/26-stage2-plan.md §1.2). Кнопка при этом обязана
 * отвечать: молчащая кнопка читается как баг.
 */
function shareRun(): void {
  const state = useRun.getState();
  if (state.result === null) return;

  useShell.getState().adapter.share({
    runScore: Math.round(state.result.survivalSec),
    runDurationSec: state.result.survivalSec,
  });
}
