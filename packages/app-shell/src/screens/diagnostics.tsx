import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { CONTENT_HASH } from "@bh/core-game";
import { Button, ContentColumn, ListGroup, ListItem, Screen, SectionTitle } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/team";
import { copyText } from "../state/clipboard";
import { readEnvironment } from "../state/device";
import { buildDeviceReport, formatDeviceReport, measureDisplayHz } from "../state/device-report";
import { useInstall } from "../state/install";
import { useNavigation } from "../state/navigation";
import { reportQueue } from "../state/run-report";
import type { ReportQueueState } from "../state/report-queue";
import { usePlatform } from "../state/platform";
import { usePlaytestAccess } from "../state/playtest";
import { useShell } from "../state/shell";
import { uiFeedback } from "../state/ui-feedback";

type CopyState = "idle" | "copied" | "manual";

/**
 * Экран диагностики (docs/28-diagnostics.md §2.2): сведения об устройстве для
 * баг-репорта одной кнопкой, последние отчёты, стресс-тест и витрина компонентов.
 */
export function DiagnosticsScreen(): ReactNode {
  const navigation = useNavigation();
  const access = usePlaytestAccess();
  const platform = usePlatform();
  const build = useShell((state) => state.build);
  const adapter = useShell((state) => state.adapter);
  const installId = useInstall((state) => state.installId);
  const [displayHz, setDisplayHz] = useState<number | null>(null);
  const [copy, setCopy] = useState<CopyState>("idle");

  useEffect(() => {
    let alive = true;
    void measureDisplayHz().then((hz) => {
      if (alive) setDisplayHz(hz);
    });
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(
    () =>
      buildDeviceReport({
        build: build.version,
        contentHash: CONTENT_HASH,
        installId,
        client: adapter.clientInfo(),
        env: readEnvironment(),
        viewport: platform.viewport,
        insets: platform.insets,
        screenMode: platform.screenMode,
        displayHz,
      }),
    [adapter, build.version, displayHz, installId, platform.insets, platform.screenMode, platform.viewport],
  );
  const text = formatDeviceReport(rows, (key) => t(`diagnostics.report.${key}`));

  const onCopy = async (): Promise<void> => {
    const copied = await copyText(text);
    setCopy(copied ? "copied" : "manual");
    uiFeedback(copied ? "reward" : "error");
  };

  return (
    <Screen title={t("diagnostics.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <SectionTitle>{t("diagnostics.device")}</SectionTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-lg border border-border bg-surface p-4 text-sm shadow-card">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-text-muted">{t(`diagnostics.report.${row.key}`)}</dt>
              <dd className="min-w-0 text-right font-display break-all text-text tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 grid gap-2">
          <Button variant="secondary" block onClick={() => void onCopy()}>
            {copy === "copied" ? t("diagnostics.copied") : t("diagnostics.copy")}
          </Button>
          <p className="text-xs text-text-muted">{t("diagnostics.copy.hint")}</p>
          {/* Буфер обмена закрыт — текст остаётся выделить руками, иначе
              сведения до команды так и не доедут. */}
          {copy === "manual" ? (
            <textarea
              readOnly
              aria-label={t("diagnostics.device")}
              className="h-48 w-full rounded-md border border-border bg-surface-raised p-3 font-mono text-xs text-text"
              value={text}
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>

        <RecentReports />

        <SectionTitle>{t("diagnostics.runBench")}</SectionTitle>
        <ListGroup>
          {access.stressTest ? <ListItem title={t("mode.stress")} onClick={() => navigation.push("stress")} /> : null}
          {/* Витрина компонентов — инструмент команды: игроку она показывает
              экраны, которых в игре ещё нет. */}
          {access.admin ? <ListItem title={t("gallery.title")} onClick={() => navigation.push("gallery")} /> : null}
        </ListGroup>
        {access.stressTest ? null : <p className="mt-2 text-xs text-text-muted">{t("diagnostics.benchClosed")}</p>}
      </ContentColumn>
    </Screen>
  );
}

/**
 * «Последние отчёты»: что ушло команде и что ждёт сети. Тестеру это ответ на
 * вопрос «дошла ли запись моего забега», а не просьба поверить на слово.
 */
function RecentReports(): ReactNode {
  const queue = reportQueue();
  const state: ReportQueueState = useSyncExternalStore(queue.subscribe, queue.state);
  const pendingBytes = state.pending.reduce((sum, report) => sum + report.bytes, 0);

  return (
    <>
      <SectionTitle>{t("diagnostics.reports")}</SectionTitle>
      <div className="grid gap-2 rounded-lg border border-border bg-surface p-4 text-sm shadow-card">
        {state.pending.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-text">
              {t("diagnostics.reports.pending", { count: state.pending.length, size: formatSize(pendingBytes) })}
            </span>
            <Button variant="secondary" onClick={() => void queue.flush("online")}>
              {t("diagnostics.reports.retry")}
            </Button>
          </div>
        ) : null}
        {state.sent.length === 0 && state.pending.length === 0 ? (
          <p className="text-text-muted">{t("diagnostics.reports.empty")}</p>
        ) : null}
        {state.sent.map((report) => (
          <div key={report.reportId} className="flex items-baseline justify-between gap-3">
            <span className="text-text">{t(`diagnostics.reports.kind.${report.kind}`)}</span>
            <span className="min-w-0 text-right font-display text-text-muted tabular-nums">
              {formatSentAt(report.sentAt)} · {formatSize(report.bytes)} · {report.reportId.slice(0, 8)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function formatSize(bytes: number): string {
  return t("diagnostics.reports.size", { value: Math.max(1, Math.round(bytes / 1024)) });
}

/** Локальное время только на отображении: хранится UTC-метка. */
function formatSentAt(atMs: number): string {
  return new Date(atMs).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
