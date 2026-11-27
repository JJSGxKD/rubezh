import { useState } from "react";
import { api } from "../../services";
import { fetchRunReplay, repeatRunReplay, type RunReplay } from "../../api/review";
import { formatDateTime } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Badge, Button, DataTable, ErrorNotice, KeyValue, Loading } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { REPLAY_REPEAT_TOAST, replayBadge, replayRepeatChanges, replayRows, replayTickText } from "./run-report-view";

/**
 * Раздел «Повтор на сервере» страницы отчёта забега (tasks/T-0319): исход
 * перепроверки, тик расхождения, таблица «заявлено / повтор» и кнопка
 * «Повторить снова». Сервер сам повторяет забеги, от которых что-то зависит,
 * и часть остальных; здесь видно, что он получил и чем это кончилось для забега.
 */
export function ReplayBlock({ runId, subject }: { runId: string; subject: string }) {
  const { state, reload } = useApi(() => fetchRunReplay(api, runId), [runId]);
  // Ответ «Повторить снова» сильнее прочитанного: он уже новое состояние, а чтение — до нажатия.
  const [repeated, setRepeated] = useState<RunReplay | null>(null);
  const [open, setOpen] = useState(false);
  const canRestrict = can(useSession((session) => session.view), "players.restrict");

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const replay = repeated ?? state.data;
  const badge = replayBadge(replay.verdict);
  const pending = replay.verdict === "pending";

  const refresh = () => {
    setRepeated(null);
    reload();
  };

  const repeat = async () => {
    const result = await repeatRunReplay(api, runId);
    if (!result.ok) return { ok: false as const, error: result.error.message };
    toast.success(REPLAY_REPEAT_TOAST);
    setRepeated(result.data);
    return { ok: true as const };
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.text}</Badge>
        {replay.verdict === null ? null : <span className="text-sm text-text-muted">{replay.required ? "обязательный повтор" : "повтор выборкой"}</span>}
        {canRestrict && replay.canRepeat ? <Button onClick={() => setOpen(true)}>Повторить снова…</Button> : null}
        {pending ? <Button onClick={refresh}>Обновить</Button> : null}
      </div>
      {replay.verdict === null ? (
        <p className="text-sm text-text-muted">{replay.hasProof ? "Серверу этот забег повторять не требовалось" : "Повтор не назначали, записи для проверки нет"}</p>
      ) : (
        <KeyValue
          items={[
            ["Расхождение", replayTickText(replay.divergedTick)],
            ["Повтор закончен", replay.replayedAt === null ? "—" : formatDateTime(replay.replayedAt)],
            ["Считал", replay.durationMs === null ? "—" : `${(replay.durationMs / 1000).toFixed(1).replace(".", ",")} с`],
            ["Что сказал воркер", replay.reason ?? "—"],
            ["Запись для проверки", replay.hasProof ? "есть" : "нет (срок хранения вышел или не пришла)"],
          ]}
        />
      )}
      <DataTable
        rows={replayRows(replay)}
        rowKey={(row) => row.label}
        columns={[
          { title: "Итог", render: (row) => row.label },
          { title: "Заявлено", render: (row) => row.claimed, align: "right" },
          { title: "Повтор", render: (row) => <span className={row.differs ? "font-medium text-danger" : undefined}>{row.replayed}</span>, align: "right" },
        ]}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Повторить забег снова?"
        subject={subject}
        changes={replayRepeatChanges(replay)}
        action="Повторить снова"
        onConfirm={repeat}
      />
    </div>
  );
}
