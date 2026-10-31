import { useEffect, useState } from "react";
import { canRun, fetchReclean, recleanActive, recleanLine, rulesChangedAfter, startPreview, startRun, stopReclean, type RulesView } from "../../api/name-rules";
import { formatNumber } from "../../format";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

/** Как часто спрашивать сервер, пока идёт проход, мс. */
const POLL_MS = 2_000;

/**
 * Перечистка старых ников: «Посчитать, кого затронет» — сухой прогон того же
 * прохода, «Перечистить» открывается только после свежего предпросмотра при тех
 * же правилах. Пока проход идёт, экран спрашивает сервер раз в две секунды.
 */
export function RecleanPanel({ view }: { view: RulesView }) {
  const { state, reload } = useApi(() => fetchReclean(api), []);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const current = state.status === "ok" ? state.data : null;
  const active = recleanActive(current);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, reload]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;

  const act = async (run: () => ReturnType<typeof startPreview>, done: string): Promise<void> => {
    setAsking(true);
    const result = await run();
    setAsking(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(done);
    reload();
  };

  const runnable = canRun(current, rulesChangedAfter(view, current), new Date());

  return (
    <Panel title="Перечистка" help={HELP.names.reclean}>
      <div className="flex flex-col gap-3">
        <p className="text-sm" aria-live="polite">
          {recleanLine(current)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={asking || active} onClick={() => void act(() => startPreview(api), "Считаем, кого затронет")}>
            Посчитать, кого затронет
          </Button>
          <Button tone="primary" disabled={asking || active || !runnable} onClick={() => setConfirming(true)}>
            Перечистить
          </Button>
          {active ? (
            <Button
              tone="danger"
              onClick={() =>
                void (async () => {
                  const result = await stopReclean(api);
                  if (!result.ok) toast.error(result.error.message);
                  else toast.success("Останавливаем: проход закончит текущую пачку");
                  reload();
                })()
              }
            >
              Остановить
            </Button>
          ) : null}
        </div>
        {current !== null && current.mode === "preview" && current.status === "done" && !runnable && rulesChangedAfter(view, current) ? (
          <p className="text-xs text-text-muted">Правила менялись после предпросмотра — посчитайте заново.</p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming && current !== null}
        onOpenChange={setConfirming}
        title="Перечистить ники?"
        action="Перечистить"
        tone="danger"
        onConfirm={async () => {
          if (current === null) return { ok: false, error: "Сначала посчитайте, кого затронет перечистка" };
          const result = await startRun(api, current.runId);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Перечистка запущена");
          reload();
          return { ok: true };
        }}
      >
        <p className="text-sm">
          Будет изменено {formatNumber(current?.planned ?? 0)} ников из {formatNumber(current?.scanned ?? 0)} проверенных. Закреплённые модератором не меняются. Отменить нельзя — прежний вид останется в поле исходного ника.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
