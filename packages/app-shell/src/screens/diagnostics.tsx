import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CONTENT_HASH } from "@bh/core-game";
import { Button, ContentColumn, ListGroup, ListItem, Screen, SectionTitle } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/team";
import { copyText } from "../state/clipboard";
import { readEnvironment } from "../state/device";
import { buildDeviceReport, formatDeviceReport, measureDisplayHz } from "../state/device-report";
import { useInstall } from "../state/install";
import { useNavigation } from "../state/navigation";
import { usePlatform } from "../state/platform";
import { usePlaytestAccess } from "../state/playtest";
import { useShell } from "../state/shell";
import { uiFeedback } from "../state/ui-feedback";

type CopyState = "idle" | "copied" | "manual";

/**
 * Экран диагностики (docs/28-diagnostics.md §2.2): сведения об устройстве для
 * баг-репорта одной кнопкой, стресс-тест и витрина компонентов.
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

        <SectionTitle>{t("diagnostics.runBench")}</SectionTitle>
        <ListGroup>
          {access.stressTest ? <ListItem title={t("mode.stress")} onClick={() => navigation.push("stress")} /> : null}
          <ListItem title={t("gallery.title")} onClick={() => navigation.push("gallery")} />
        </ListGroup>
        {access.stressTest ? null : <p className="mt-2 text-xs text-text-muted">{t("diagnostics.benchClosed")}</p>}
      </ContentColumn>
    </Screen>
  );
}
