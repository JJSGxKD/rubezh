import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, CircleCheck, Flame, RotateCcw, Send, Square, TriangleAlert } from "lucide-react";
import type { BenchProgress, BenchSubmission } from "@bh/core-game";
import {
  Badge,
  Button,
  ContentColumn,
  ErrorState,
  IconEmblem,
  Modal,
  ProgressBar,
  Screen,
  Stat,
} from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";
import "../../i18n/team";
import { useNavigation } from "../../state/navigation";
import { useStress, type StressPhase, type StressSendState } from "../../state/stress";

/**
 * Стресс-тест из раздела «Играть» (docs/28-diagnostics.md §2.3).
 *
 * Три состояния одного экрана: памятка перед прогоном, канва с короткой
 * сводкой поверх и итог. Канва монтируется только на прогон — памятка не
 * держит контекст WebGL, пока человек читает.
 */
export function StressScreen(): ReactNode {
  const navigation = useNavigation();
  const phase = useStress((state) => state.phase);
  const [attempt, setAttempt] = useState(0);

  // Уход с экрана уносит движок и итог: на повторный заход — снова памятка.
  useEffect(() => () => useStress.getState().dispose(), []);

  if (attempt === 0) {
    return <StressIntro onStart={() => setAttempt(1)} onBack={() => navigation.pop()} />;
  }
  return (
    <StressRun
      key={attempt}
      phase={phase}
      onAgain={() => {
        useStress.getState().dispose();
        setAttempt((value) => value + 1);
      }}
      onDone={() => navigation.pop()}
    />
  );
}

function StressIntro(props: { onStart(): void; onBack(): void }): ReactNode {
  return (
    <Screen
      title={t("stress.title")}
      onBack={props.onBack}
      footer={
        <Button size="l" block glow onClick={props.onStart}>
          <Activity size={20} />
          {t("stress.start")}
        </Button>
      }
    >
      <ContentColumn>
        <div className="mt-2 flex flex-col items-center gap-3 text-center">
          <IconEmblem tone="accent">
            <Flame size={26} />
          </IconEmblem>
          <p className="max-w-[360px] text-sm text-text-muted">{t("stress.intro")}</p>
        </div>
        <ul className="surface-sunken mt-5 grid gap-3 rounded-lg p-4 text-sm text-text">
          {(["duration", "stay", "heat", "privacy"] as const).map((key) => (
            <li key={key} className="flex gap-2">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              <span>{t(`stress.memo.${key}`)}</span>
            </li>
          ))}
        </ul>
      </ContentColumn>
    </Screen>
  );
}

function StressRun(props: { phase: StressPhase; onAgain(): void; onDone(): void }): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const progress = useStress((state) => state.progress);
  const submission = useStress((state) => state.submission);
  const sendState = useStress((state) => state.sendState);
  const errorMessage = useStress((state) => state.errorMessage);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    void useStress.getState().start(container);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <div ref={containerRef} className="absolute inset-0" style={{ zIndex: "var(--z-canvas)" }} />

      {props.phase === "loading" || progress === null ? (
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: "var(--z-hud)" }}>
          <p className="animate-pulse-soft font-display text-sm text-text-muted">{t("stress.loading")}</p>
        </div>
      ) : null}

      {progress !== null && props.phase === "running" ? (
        <StressHud progress={progress} onStop={() => useStress.getState().stop()} />
      ) : null}

      {props.phase === "finished" && submission !== null ? (
        <StressResult
          submission={submission}
          sendState={sendState}
          onResend={() => void useStress.getState().send()}
          onAgain={props.onAgain}
          onDone={props.onDone}
        />
      ) : null}

      {props.phase === "error" ? (
        <div className="absolute inset-0 bg-bg" style={{ zIndex: "var(--z-modal)" }}>
          <ErrorState text={t(errorMessage ?? "error.engine")} onRetry={props.onDone} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Сводка поверх канвы. Как HUD забега: статичные подложки без размытия,
 * обновление четыре раза в секунду, касания проходят сквозь слой — кроме
 * кнопки остановки (docs/27-design-system-and-app-shell.md §3.3).
 */
function StressHud(props: { progress: BenchProgress; onStop(): void }): ReactNode {
  const { progress } = props;
  const dropping = progress.badWindows > 0;

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col" style={{ zIndex: "var(--z-hud)" }}>
      <div className="flex flex-col gap-2 pt-[calc(0.5rem+var(--app-inset-top))] pr-[calc(1rem+var(--app-inset-right))] pl-[calc(1rem+var(--app-inset-left))]">
        <div className="flex items-start justify-between gap-3">
          <div className="rounded-lg bg-bg/75 px-3 py-2">
            <span className="block font-display text-xs font-semibold tracking-wide text-text-muted uppercase">
              {t("stress.hud.objects")}
            </span>
            <span className="font-display text-3xl font-bold tabular-nums text-text">
              {formatNumber(progress.objects)}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="rounded-pill bg-bg/75 px-3 py-0.5 font-display text-xl font-bold tabular-nums text-text">
              {formatDuration(progress.elapsedSec)}
            </span>
            <span
              className={[
                "rounded-pill bg-bg/75 px-3 py-0.5 font-display text-sm font-bold tabular-nums",
                dropping ? "text-warning" : "text-text",
              ].join(" ")}
            >
              {progress.fps === null ? "— FPS" : `${Math.round(progress.fps)} FPS`}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <HudChip label={t("stress.hud.enemies")} value={progress.enemies} />
          <HudChip label={t("stress.hud.projectiles")} value={progress.projectiles} />
          <HudChip label={t("stress.hud.gems")} value={progress.gems} />
        </div>
        {dropping ? (
          <div className="self-start">
            <Badge tone="warning">
              <TriangleAlert size={12} aria-hidden="true" />
              {t("stress.hud.dropping", { seconds: progress.badWindows })}
            </Badge>
          </div>
        ) : null}
        {progress.interruptions > 0 ? (
          <p className="self-start rounded-md bg-bg/75 px-2 py-1 text-xs text-warning">{t("stress.interrupted")}</p>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col items-center gap-2 px-4 pb-[calc(0.75rem+var(--app-inset-bottom))]">
        <div className="w-full max-w-[320px] rounded-pill bg-bg/75 p-1">
          <ProgressBar
            value={progress.elapsedSec}
            max={progress.durationSec}
            tone="accent"
            height="thin"
            label={t("stress.hud.limit")}
          />
        </div>
        <div className="pointer-events-auto">
          <Button variant="secondary" onClick={props.onStop}>
            <Square size={16} fill="currentColor" />
            {t("stress.stop")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HudChip(props: { label: string; value: number }): ReactNode {
  return (
    <span className="rounded-pill bg-bg/75 px-2.5 py-0.5 text-xs text-text-muted">
      {props.label} <span className="font-display font-bold tabular-nums text-text">{formatNumber(props.value)}</span>
    </span>
  );
}

function StressResult(props: {
  submission: BenchSubmission;
  sendState: StressSendState;
  onResend(): void;
  onAgain(): void;
  onDone(): void;
}): ReactNode {
  const { report, verdict } = props.submission;
  const totals = report.totals;
  const found = report.stoppedBy === "degradation";
  const title =
    report.stoppedBy === "manual" ? "stress.result.stopped" : found ? "stress.result.found" : "stress.result.notFound";

  return (
    <Modal
      title={t(title)}
      icon={found ? <Flame size={26} /> : <CircleCheck size={26} />}
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" block onClick={props.onAgain}>
            <RotateCcw size={18} />
            {t("stress.again")}
          </Button>
          <Button block glow onClick={props.onDone}>
            {t("stress.done")}
          </Button>
        </div>
      }
    >
      <p className="-mt-1 mb-3 text-center text-sm text-text-muted">{t(`stress.stopped.${report.stoppedBy}`)}</p>
      <div className="surface-sunken grid grid-cols-2 gap-4 rounded-lg p-4">
        <Stat label={t("stress.result.peak")} value={formatNumber(Math.round(totals.peakObjects))} large tone="accent" />
        {/* Сколько врагов устройство держало в пределах порогов плавности —
            то число, под которое геймдизайнер может планировать толпу. */}
        <Stat
          label={t("stress.result.holds")}
          value={verdict.sustainedLoad > 0 ? formatNumber(Math.round(verdict.sustainedLoad)) : "—"}
          large
        />
        <Stat label={t("stress.result.avgFps")} value={totals.avgFps.toFixed(0)} />
        <Stat label={t("stress.result.p95")} value={t("stress.result.ms", { ms: totals.p95FrameMs.toFixed(1) })} />
        <Stat label={t("stress.result.screen")} value={t("stress.result.hz", { hz: totals.displayHz })} />
        <Stat label={t("stress.result.duration")} value={formatDuration(totals.durationSec)} />
      </div>
      {report.interruptions > 0 ? <p className="mt-3 text-xs text-warning">{t("stress.interrupted")}</p> : null}
      <SendStatus state={props.sendState} onResend={props.onResend} />
    </Modal>
  );
}

function SendStatus(props: { state: StressSendState; onResend(): void }): ReactNode {
  if (props.state === "idle") return null;
  if (props.state === "failed") {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-warning">{t("stress.send.failed")}</span>
        <Button variant="ghost" onClick={props.onResend}>
          <Send size={16} />
          {t("stress.send.retry")}
        </Button>
      </div>
    );
  }
  return (
    <p className={["mt-3 text-xs", props.state === "sent" ? "text-success" : "text-text-muted"].join(" ")}>
      {t(`stress.send.${props.state}`)}
    </p>
  );
}
