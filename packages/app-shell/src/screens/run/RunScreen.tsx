import { useEffect, useRef, type ReactNode } from "react";
import { DEFAULT_MAP_ID } from "@bh/core-game";
import { ErrorState } from "../../design-system/components";
import { t } from "../../i18n";
import { useDiagnostics } from "../../state/diagnostics";
import { useMeta } from "../../state/meta";
import { useNavigation } from "../../state/navigation";
import { usePlatform } from "../../state/platform";
import { useRun } from "../../state/run";
import { useShell } from "../../state/shell";
import { RunHud } from "./RunHud";
import { DeathOverlay, LevelUpOverlay, PauseOverlay } from "./overlays";

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

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Оружие читается разово из стора, а не из подписки: смена запомненного
    // выбора посреди забега не должна его перезапускать.
    void useRun.getState().start({
      container,
      startingWeaponId: useMeta.getState().lastWeaponId,
      mapId: DEFAULT_MAP_ID,
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

      {run.hud === null || run.phase === "finished" ? null : (
        <RunHud hud={run.hud} onPause={() => useRun.getState().pause("manual")} />
      )}

      {run.phase === "paused" ? (
        <PauseOverlay
          elapsedSec={run.hud?.survivalSec ?? 0}
          onResume={() => useRun.getState().resume()}
          onSettings={() => navigation.push("settings")}
          onSurrender={() => useRun.getState().surrender()}
        />
      ) : null}

      {run.phase === "levelUp" ? (
        <LevelUpOverlay
          level={run.level}
          offers={run.offers}
          queued={run.queued}
          onChoose={(optionId) => useRun.getState().choose(optionId)}
        />
      ) : null}

      {run.phase === "finished" && run.result !== null ? (
        <DeathOverlay
          result={run.result}
          isNewRecord={run.isNewRecord}
          diagnostics={diagnostics}
          onRestart={() => useRun.getState().restart()}
          onMenu={() => navigation.resetTo("lobby")}
          onShare={() => shareRun()}
        />
      ) : null}

      {run.phase === "error" ? (
        <div className="absolute inset-0 bg-bg" style={{ zIndex: "var(--z-modal)" }}>
          <ErrorState text={t("error.engine")} onRetry={() => navigation.resetTo("lobby")} />
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
