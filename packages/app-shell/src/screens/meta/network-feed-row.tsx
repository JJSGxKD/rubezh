import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, ExternalLink } from "lucide-react";
import { Button, Card } from "../../design-system/components";
import { t } from "../../i18n";
import { usePlatform } from "../../state/platform";
import { track, useShell } from "../../state/shell";
import { createTasksApi, feedActionKey, feedCheckNotice, type FeedHints, type FeedTask, type NetworkTaskItem } from "../../state/tasks-api";
import { AdLabel } from "./ad-label";
import { TaskImage } from "./task-image";
import { RewardChips } from "./task-reward";

/**
 * Строка задания ленты сети — обмен трафиком Taddy (docs/35-stage4-plan.md
 * WP13, часть 6). В отличие от AdsGram, задание рисуем мы: картинка, текст
 * и награда — из ленты через сервер, кнопки — наши. Задание строка
 * спрашивает сама, когда её видно: экран заданий сеть не ждёт.
 *
 * «Перейти» просит у сети адрес перехода через адаптер площадки и открывает
 * его. Выполнение подтверждает только сеть: вернулся игрок в приложение —
 * строка один раз спрашивает сервер сама, дальше — «Проверить». Подсказка
 * под кнопками говорит, что случилось, — без всплывающих окон.
 */

const api = createTasksApi();

/** Чаще проверку при возвращении не повторяем: игрок мог переключиться туда-обратно за секунду. */
const RECHECK_GAP_MS = 3_000;

export interface FeedProgress {
  doneToday: number;
  nextAt: string | null;
}

type RowState =
  | { kind: "loading" }
  | { kind: "task"; task: FeedTask; opened: boolean; busy: "open" | "check" | null; notice: string | null };

export interface FeedRowProps {
  item: NetworkTaskItem;
  index: number;
  /** сеть подтвердила выполнение, награда выдана — строка уходит в «готово» */
  onDone: (progress: FeedProgress) => void;
  /** заданий сейчас нет — строки нет */
  onGone: () => void;
}

function hintsOf(): FeedHints {
  const client = useShell.getState().adapter.clientInfo();
  return { language: client.language ?? null, premium: client.premium ?? null };
}

export function FeedRow(props: FeedRowProps): ReactNode {
  const { item } = props;
  const [state, setState] = useState<RowState>({ kind: "loading" });
  const active = usePlatform((platform) => platform.isActive);
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
  const shown = useRef<string | null>(null);
  const lastCheck = useRef(0);

  const load = async (): Promise<void> => {
    setState({ kind: "loading" });
    const response = await api.networkItem(item.network, hintsOf());
    if (!alive.current) return;
    if (!response.ok || response.data.kind === "none") return latest.current.onGone();
    if (response.data.kind === "done") return latest.current.onDone({ doneToday: response.data.doneToday, nextAt: response.data.nextAt });
    const task = response.data.task;
    setState({ kind: "task", task, opened: task.opened, busy: null, notice: null });
  };

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  const task = state.kind === "task" ? state.task : null;

  // Показ — для воронки и для сети: задание на экране игрока.
  useEffect(() => {
    if (task === null || shown.current === task.sessionId) return;
    shown.current = task.sessionId;
    void api.networkStep(task.sessionId, "shown");
  }, [task?.sessionId]);

  const patch = (next: Partial<Extract<RowState, { kind: "task" }>>): void =>
    setState((current) => (current.kind === "task" ? { ...current, ...next } : current));

  const check = async (auto: boolean): Promise<void> => {
    if (state.kind !== "task" || state.busy !== null) return;
    lastCheck.current = Date.now();
    patch({ busy: "check", ...(auto ? {} : { notice: null }) });
    const response = await api.networkCheck(item.network, state.task.sessionId, hintsOf());
    if (!alive.current) return;
    if (!response.ok) return patch({ busy: null, notice: t("tasks.network.unavailable", { network: item.title }) });
    const { result, doneToday, nextAt } = response.data;
    if (result === "confirmed") return latest.current.onDone({ doneToday, nextAt });
    if (result === "closed") return void load();
    patch({ busy: null, notice: t(feedCheckNotice(result) ?? "tasks.network.unavailable", { network: item.title }) });
  };

  // Вернулся в приложение после перехода — проверить один раз самим.
  useEffect(() => {
    if (!active || state.kind !== "task" || !state.opened || Date.now() - lastCheck.current < RECHECK_GAP_MS) return;
    void check(true);
  }, [active]);

  const open = async (): Promise<void> => {
    if (state.kind !== "task" || state.busy !== null) return;
    const { adapter } = useShell.getState();
    const current = state.task;
    patch({ busy: "open", notice: null });
    const result = adapter.openNetworkTask === undefined ? "failed" : await adapter.openNetworkTask({ network: current.network, link: current.link });
    if (!alive.current) return;
    if (result === "failed") return patch({ busy: null, notice: t("tasks.network.openFailed") });
    track("task_link_opened", { task: item.network, kind: "network", network: item.network });
    void api.networkStep(current.sessionId, "clicked");
    // Отсчёт — с перехода: возвращение сразу после него проверить стоит.
    lastCheck.current = 0;
    patch({ busy: null, opened: true, notice: t("tasks.network.afterOpen", { network: item.title }) });
  };

  if (state.kind !== "task") return null;
  const { opened, busy, notice } = state;

  return (
    <Card appearIndex={props.index}>
      <AdLabel network={item.title} />
      <div className="flex items-center gap-3">
        <TaskImage src={state.task.image} fallback={<FeedIcon action={state.task.action} />} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-display text-sm font-bold text-text">{state.task.title}</p>
          {state.task.description === null ? null : <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{state.task.description}</p>}
        </div>
        <RewardChips reward={item.reward} />
      </div>
      {opened ? (
        // В половине ширины «Запустить бота» переносится — второй раз хватит «Открыть».
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="secondary" loading={busy === "open"} disabled={busy === "check"} onClick={() => void open()}>
            {t("tasks.network.reopen")}
          </Button>
          <Button loading={busy === "check"} disabled={busy === "open"} onClick={() => void check(false)}>
            {t("tasks.check")}
          </Button>
        </div>
      ) : (
        <div className="mt-3">
          <Button block loading={busy === "open"} onClick={() => void open()}>
            <ExternalLink size={18} aria-hidden="true" />
            {t(feedActionKey(state.task.action))}
          </Button>
        </div>
      )}
      {notice === null ? null : (
        <p className="mt-2 text-xs font-semibold text-text-muted" role="status">
          {notice}
        </p>
      )}
    </Card>
  );
}

/** Нет картинки в ленте — значок вида, как у своих заданий: бот или ссылка. */
function FeedIcon(props: { action: FeedTask["action"] }): ReactNode {
  return (
    <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted">
      {props.action === "bot" ? <Bot size={20} aria-hidden="true" /> : <ExternalLink size={20} aria-hidden="true" />}
    </span>
  );
}
