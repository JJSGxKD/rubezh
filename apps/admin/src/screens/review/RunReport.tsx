import { useState, type ReactNode } from "react";
import { api } from "../../services";
import { DECISION_REASON, annulRun, fetchRunReport, markHonest, restoreRun, type RunReport as Report } from "../../api/run-report";
import { fetchRestrictionCatalog, fetchRestrictions } from "../../api/restrictions";
import { difficultyTitle, reasonTitle } from "../../api/review";
import { formatDateTime, formatDuration, formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, KeyValue, Loading, Notice, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { RestrictDialog } from "../players/RestrictDialog";
import {
  annulChanges,
  AXIS_ORDER,
  AXIS_TITLES,
  axisText,
  decisionToast,
  honestChanges,
  ratingText,
  restoreChanges,
  reviewText,
  STYLE_TITLES,
  verdictBadge,
  type DecisionAction,
} from "./run-report-view";

/**
 * Страница отчёта забега (Р203, tasks/T-0420): что было в забеге, почему
 * проверка его остановила, из чего сложились очки — и решения команды.
 * Права — как в шапке карточки игрока; что разрешает состояние забега,
 * сказал сервер (`actions`). После решения страница показывает его ответ, а
 * не уходит в очередь: модератор видит, что решение записано.
 */
export function RunReport({ runId }: { runId: string }) {
  const { state, reload } = useApi(() => fetchRunReport(api, runId), [runId]);
  // Ответ решения сильнее прочитанного отчёта, пока страницу не перечитали.
  const [decided, setDecided] = useState<Report | null>(null);
  const refresh = () => {
    setDecided(null);
    reload();
  };
  const back = <Button onClick={() => navigate({ section: "review", id: null })}>← К очереди</Button>;

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div>{back}</div>
        {state.error.kind === "not_found" ? <Notice tone="warning">Забег не найден</Notice> : <ErrorNotice error={state.error} onRetry={refresh} />}
      </div>
    );
  }
  const report = decided ?? state.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {back}
        <a href={hrefOf({ section: "players", id: report.accountId })} className="text-sm text-accent hover:underline">
          Карточка игрока
        </a>
      </div>
      <ReportPanel key={report.runId} report={report} onDecided={setDecided} onRefresh={refresh} />
    </div>
  );
}

function ReportPanel({ report, onDecided, onRefresh }: { report: Report; onDecided: (report: Report) => void; onRefresh: () => void }) {
  const view = useSession((session) => session.view);
  const canRestrict = can(view, "players.restrict");
  const canBan = can(view, "players.ban");
  const catalog = useApi(() => fetchRestrictionCatalog(api), []);
  const restrictions = useApi(() => fetchRestrictions(api, report.accountId), [report.accountId]);
  const [dialog, setDialog] = useState<DecisionAction | "restrict" | null>(null);
  // Отказ сервера (409) значит, что отчёт устарел: после закрытия окна страница перечитывается.
  const [refused, setRefused] = useState(false);

  const name = report.displayName ?? report.accountId.slice(0, 8);
  const short = report.runId.slice(0, 8);
  const subject = `${name} · ${short}`;
  const active = restrictions.state.status === "ok" ? restrictions.state.data.restrictions.filter((row) => row.state === "active") : [];
  const badge = verdictBadge(report.verdict);
  const decision = reviewText(report.review);

  const close = (open: boolean) => {
    if (open) return;
    setDialog(null);
    if (refused) {
      setRefused(false);
      onRefresh();
    }
  };

  const decide = async (action: DecisionAction, reason: string) => {
    const result =
      action === "honest" ? await markHonest(api, report.runId) : action === "annul" ? await annulRun(api, report.runId, reason) : await restoreRun(api, report.runId, reason);
    if (!result.ok) {
      if (result.error.status === 409) setRefused(true);
      return { ok: false as const, error: result.error.message };
    }
    toast.success(decisionToast(action, result.data));
    onDecided(result.data);
    return { ok: true as const };
  };

  const reasonRule = { min: DECISION_REASON.min, max: DECISION_REASON.max, label: "Причина", hint: "Останется в журнале действий" };

  return (
    <>
      <Panel
        title={`Забег ${short}`}
        help={HELP.review.report}
        actions={
          canRestrict || canBan ? (
            <div className="flex min-w-0 flex-wrap justify-end gap-1.5">
              {canRestrict && report.actions.honest ? (
                <Button tone="primary" onClick={() => setDialog("honest")}>
                  Честный
                </Button>
              ) : null}
              {canRestrict && report.actions.annul ? (
                <Button tone="danger" onClick={() => setDialog("annul")}>
                  Аннулировать…
                </Button>
              ) : null}
              {canRestrict && report.actions.restore ? (
                <Button tone="primary" onClick={() => setDialog("restore")}>
                  Вернуть забег…
                </Button>
              ) : null}
              {catalog.state.status === "ok" ? <Button onClick={() => setDialog("restrict")}>Ограничить игрока…</Button> : null}
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{name}</span>
            <Badge tone={badge.tone}>{badge.text}</Badge>
            <Badge tone={report.rating.ranked ? "success" : "neutral"}>{report.rating.ranked ? "В рейтинге" : "Не в рейтинге"}</Badge>
            {decision === null ? null : <span className="text-sm text-text-muted">{decision}</span>}
          </div>
          <Section title="Почему остановлен">
            {report.verdictReasons.length === 0 ? (
              <p className="text-sm text-text-muted">Причин нет</p>
            ) : (
              <ul className="list-disc pl-5 text-sm">
                {report.verdictReasons.map((code) => (
                  <li key={code}>{reasonTitle(code)}</li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Итог">
            <KeyValue items={summaryItems(report)} />
          </Section>
          <Section title="Очки">
            <ScoreBlock report={report} />
          </Section>
          <Section title="Ход боя">
            <CombatBlock report={report} />
          </Section>
        </div>
      </Panel>

      <ConfirmDialog
        open={dialog === "honest"}
        onOpenChange={close}
        title="Забег честный?"
        subject={subject}
        changes={honestChanges(report)}
        action="Честный"
        onConfirm={() => decide("honest", "")}
      />
      <ConfirmDialog
        open={dialog === "annul"}
        onOpenChange={close}
        title="Аннулировать забег"
        subject={subject}
        changes={annulChanges(report)}
        reason={reasonRule}
        action="Аннулировать"
        tone="danger"
        onConfirm={(reason) => decide("annul", reason)}
      />
      <ConfirmDialog
        open={dialog === "restore"}
        onOpenChange={close}
        title="Вернуть забег?"
        subject={subject}
        changes={restoreChanges(report)}
        reason={reasonRule}
        action="Вернуть забег"
        onConfirm={(reason) => decide("restore", reason)}
      />
      {catalog.state.status === "ok" ? (
        <RestrictDialog
          open={dialog === "restrict"}
          onOpenChange={(open) => setDialog(open ? "restrict" : null)}
          playerName={name}
          accountId={report.accountId}
          catalog={catalog.state.data}
          active={active}
          canBan={canBan}
          canRestrict={canRestrict}
          onDone={restrictions.reload}
        />
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

const MODE_TITLES: Readonly<Record<string, string>> = { endless: "бесконечный", prologue: "пролог" };

function outcomeTitle(outcome: string | null): string {
  return outcome === "died" ? "погиб" : outcome === "abandoned" ? "сдался" : "—";
}

function rubezhTitle(rubezh: Report["rubezh"]): string {
  if (rubezh.clearedSec !== null) return `страж пал на ${formatDuration(rubezh.clearedSec)}`;
  return rubezh.reached ? "страж пришёл, не пал" : "не дошёл";
}

function continuesTitle(continues: readonly number[]): string {
  return continues.length === 0 ? "0" : `${continues.length} (${continues.map((sec) => `${sec} с`).join(", ")})`;
}

function summaryItems(report: Report): [string, ReactNode][] {
  return [
    ["Сложность", difficultyTitle(report.difficulty)],
    ["Режим", MODE_TITLES[report.mode] ?? report.mode],
    ["Время", report.survivalSec === null ? "—" : formatDuration(report.survivalSec)],
    ["Уровень", report.level ?? "—"],
    ["Убийств", report.enemiesKilled === null ? "—" : formatNumber(report.enemiesKilled)],
    ["Исход", outcomeTitle(report.outcome)],
    ["Причина смерти", report.deathCause ?? "—"],
    ["Начат", report.startedAt === null ? "старт не дошёл" : formatDateTime(report.startedAt)],
    ["Закончен", formatDateTime(report.finishedAt)],
    ["Вторых шансов", continuesTitle(report.continues)],
    ["Читы разработчика", report.cheats ? "да" : "нет"],
    ["Рубеж", rubezhTitle(report.rubezh)],
    ["Отпечаток контента", <code key="hash" className="break-all text-xs">{report.contentHash}</code>],
    ["Рейтинг", ratingText(report.rating)],
  ];
}

function orDash(value: number | null): ReactNode {
  return value === null ? "—" : formatNumber(value);
}

function ScoreBlock({ report }: { report: Report }) {
  const { score, scoreInput } = report;
  if (score === null) return <p className="text-sm text-text-muted">Очков нет: пролог, обучение или сбой подсчёта</p>;
  const style = (STYLE_TITLES as Readonly<Record<string, string>>)[score.style] ?? score.style;
  return (
    <div className="flex flex-col gap-3">
      <KeyValue
        items={[
          ["Очки", formatNumber(score.points)],
          ["Ожидалось", orDash(score.expectedPoints)],
          ["Стиль", style],
          ["Полоса силы", score.band],
          ["Сила на старте", orDash(scoreInput?.power ?? null)],
          ["Оценка сборки", orDash(scoreInput?.buildScore ?? null)],
        ]}
      />
      <DataTable
        rows={AXIS_ORDER}
        rowKey={(axis) => axis}
        columns={[
          { title: "Ось", render: (axis) => AXIS_TITLES[axis] },
          { title: "Значение", render: (axis) => axisText(score.axes[axis]), align: "right" },
        ]}
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm text-text-muted">Охота</span>
        {scoreInput === null || scoreInput.huntLog === null || scoreInput.huntLog.length === 0 ? (
          <span className="text-sm">—</span>
        ) : (
          <DataTable
            rows={scoreInput.huntLog.map((row, index) => ({ ...row, index }))}
            rowKey={(row) => String(row.index)}
            columns={[
              { title: "Ранг", render: (row) => (row.rank === "boss" ? "босс" : row.rank === "elite" ? "элита" : row.rank) },
              { title: "Ценность", render: (row) => formatNumber(row.value), align: "right" },
              { title: "Жил", render: (row) => `${formatNumber(row.aliveSec)} с`, align: "right" },
            ]}
          />
        )}
      </div>
    </div>
  );
}

function CombatBlock({ report }: { report: Report }) {
  const { details, weapons } = report;
  if (details === null) return <p className="text-sm text-text-muted">Подробностей нет: сборка до листа забега</p>;
  const counters = [details.bossKills, details.eliteKills, details.chestsOpened, details.crystals].map((value) => (value === null ? "—" : formatNumber(value))).join(" / ");
  return (
    <div className="flex flex-col gap-3">
      <DataTable
        rows={weapons}
        rowKey={(weapon) => weapon.id}
        empty="Оружия нет"
        columns={[
          { title: "Оружие", render: (weapon) => <code className="text-xs">{weapon.id}</code> },
          { title: "Уровень", render: (weapon) => weapon.level, align: "right" },
          { title: "Урон", render: (weapon) => (weapon.damage === null || weapon.damage === undefined ? "—" : formatNumber(weapon.damage)), align: "right" },
        ]}
      />
      <KeyValue
        items={[
          [
            "Навыки",
            details.passives.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {details.passives.map((passive) => (
                  <span key={passive.id}>
                    <code className="text-xs">{passive.id}</code> {passive.level}
                  </span>
                ))}
              </span>
            ),
          ],
          ["Получено урона", orDash(details.damageTaken)],
          ["Собрано опыта", orDash(details.xpCollected)],
          ["Отрезок таймлайна", orDash(details.waveReached)],
          ["Боссов / элит / сундуков / кристаллов", counters],
          [
            "Чаще всего убивал",
            details.topKills.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {details.topKills.map((kill) => (
                  <span key={kill.enemy}>
                    <code className="text-xs">{kill.enemy}</code> × {formatNumber(kill.count)}
                  </span>
                ))}
              </span>
            ),
          ],
        ]}
      />
    </div>
  );
}
