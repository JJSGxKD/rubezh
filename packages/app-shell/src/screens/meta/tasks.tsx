import { useEffect, useState, type ReactNode } from "react";
import { Clock } from "lucide-react";
import { ContentColumn, ErrorState, InfoNotice, PageTitle, Screen, SegmentedControl } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/tasks";
import { loadBadges } from "../../state/badges-api";
import { restrictionRefusal, useRestricted } from "../../state/restrictions";
import { track, useShell } from "../../state/shell";
import {
  TASK_LIMIT_REACHED,
  TASK_NOT_DONE,
  claimFailureKey,
  createTasksApi,
  isClaimable,
  isFeedTask,
  openTaskLink,
  sortTasks,
  taskImageUrl,
  tabOf,
  tasksAvailable,
  type NetworkTaskItem,
  type TaskItem,
  type TaskTab,
} from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { formatCountdown, msUntilReset, type ResetPeriod } from "./schedule";
import { NetworkTasks } from "./network-tasks";
import { RestrictedPlaque } from "./restricted-plaque";
import { TaskRow } from "./task-row";
import { rewardText } from "./task-reward";

/**
 * «Задания»: ежедневные, недельные и достижения
 * (docs/27-design-system-and-app-shell.md §6, docs/35-stage4-plan.md WP13).
 *
 * Прогресс и награды — с сервера: он засчитывает записанные забеги, а не то,
 * что прислал клиент. Каталог правится из панели без релиза, поэтому экран
 * рисует то, что пришло, — и незнакомый вид цели тоже, с заголовком из
 * каталога.
 *
 * Партнёрские цели (Р52) — своей вкладкой. Подписка на канал: «Подписаться»
 * открывает канал через площадку, «Проверить» просит сервер спросить бота и
 * сразу забирает награду. Ссылка и бот: «Перейти» открывает ссылку и
 * засчитывает переход, дальше — «Забрать». Полосы прогресса у них нет —
 * действие либо сделано, либо нет.
 *
 * Там же — задания рекламных сетей (WP13, часть 6, `network-tasks.tsx`):
 * сразу за тем, что можно забрать.
 */
type View = "daily" | "weekly" | "achievements" | "partner";
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; tasks: TaskItem[]; networks: NetworkTaskItem[] };

const TAB_OF: Record<View, TaskTab> = { daily: "daily", weekly: "weekly", achievements: "achievement", partner: "partner" };

const api = createTasksApi();
/** Партнёрские задания — свои и сетей — закрывает своё ограничение (WP44). */
const PARTNER_RESTRICTION = ["partner_tasks"];

export function TasksScreen(): ReactNode {
  // Пока игрок не выбрал сам — партнёрские, если они есть: они первые в очереди
  // (решение участника 1, 01.10.2026). Нет партнёрских — ежедневные.
  const [chosen, setView] = useState<View | null>(null);
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ taskId: string; text: string } | null>(null);
  // Цели, места в которых кончились, пока экран открыт: строка остаётся с
  // объяснением, но без кнопок и остатка — со следующим открытием её не будет.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const close = (taskId: string): void => {
    setClosed((current) => new Set(current).add(taskId));
    setNotice({ taskId, text: t("tasks.limitReached") });
  };

  const [networkRows, setNetworkRows] = useState(0);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await api.view();
    if (!response.ok) return setState({ status: "failed" });
    const networks = response.data.networks ?? [];
    setState({ status: "ready", tasks: response.data.tasks, networks });
    // Вкладка по умолчанию решается однажды, по первому ответу: задание сети
    // уходит на паузу посреди проверки, и экран не должен сам перескочить
    // с «Партнёров» на «День», пока игрок ждёт награду.
    const partner = networks.some((item) => item.offer !== null || (isFeedTask(item) && item.nextAt === null)) || response.data.tasks.some((task) => tabOf(task) === "partner");
    setView((current) => current ?? (partner ? "partner" : "daily"));
  };

  /** Перечитать без «загрузки» на экране — за подтверждением задания сети. */
  const refresh = async (): Promise<NetworkTaskItem[] | null> => {
    const response = await api.view();
    if (!response.ok) return null;
    const networks = response.data.networks ?? [];
    setState({ status: "ready", tasks: response.data.tasks, networks });
    return networks;
  };

  useEffect(() => {
    if (tasksAvailable()) void load();
  }, []);

  const claim = async (task: TaskItem): Promise<void> => {
    if (claiming !== null) return;
    setClaiming(task.id);
    setNotice(null);
    const response = await api.claim(task.id);
    setClaiming(null);
    if (!response.ok) {
      if (response.code === TASK_LIMIT_REACHED) return close(task.id);
      // Закрыто ограничением — плашка над вкладкой скажет, что и до какого числа.
      const refusal = await restrictionRefusal(response, PARTNER_RESTRICTION);
      if (refusal === "restricted") return;
      setNotice({ taskId: task.id, text: t(refusal === "lifted" ? "restricted.lifted" : claimFailureKey(response.code)) });
      if (response.code === TASK_NOT_DONE) void load();
      return;
    }
    setState((current) => ({ status: "ready", tasks: response.data.tasks, networks: current.status === "ready" ? current.networks : [] }));
    if (response.data.claimed) {
      if (task.period === "achievement") track("achievement_unlocked", { achievement: task.id, kind: task.kind });
      else track("task_completed", { task: task.id, period: task.period, kind: task.kind });
      setNotice({ taskId: task.id, text: t("tasks.got", { what: rewardText(response.data.credited) }) });
      void loadWallet();
    }
    void loadBadges();
  };

  const all = state.status === "ready" ? state.tasks : [];
  const networks = state.status === "ready" ? state.networks : [];
  const view: View = chosen ?? "daily";
  const tasks = sortTasks(all.filter((task) => tabOf(task) === TAB_OF[view]));
  // Порядок вкладки общий (WP13, часть 6): что можно забрать — первым,
  // задания сетей — сразу за ним, дальше — остальное.
  const claimable = tasks.filter(isClaimable);
  const rest = tasks.filter((task) => !isClaimable(task));
  const partner = view === "partner";
  const partnerClosed = useRestricted(PARTNER_RESTRICTION);
  // Знак на вкладке — сколько наград там ждёт: игрок видит их, не перебирая вкладки.
  const waiting = (tab: TaskTab) => all.filter((task) => tabOf(task) === tab && isClaimable(task)).length;

  /**
   * Ссылка открывается сразу, в том же нажатии: площадка открывает ссылки
   * только в ответ на касание. Переход засчитывает сервер — уже после.
   */
  const open = (task: TaskItem, link: string): void => {
    track("task_link_opened", { task: task.id, kind: task.kind });
    openTaskLink(link);
    void api.open(task.id).then((response) => {
      if (response.ok) setState((current) => ({ status: "ready", tasks: response.data.tasks, networks: current.status === "ready" ? current.networks : [] }));
      else if (response.code === TASK_LIMIT_REACHED) close(task.id);
    });
  };

  const row = (task: TaskItem, index: number): ReactNode => (
    <TaskRow
      key={task.id}
      index={index}
      task={task}
      image={taskImageUrl(task.image, useShell.getState().capabilities.auth?.baseUrl)}
      claiming={claiming === task.id}
      notice={notice?.taskId === task.id ? notice.text : null}
      // Под ограничением строки партнёрской вкладки — без кнопок: причину объясняет плашка.
      closed={closed.has(task.id) || (partnerClosed && tabOf(task) === "partner")}
      onClaim={() => void claim(task)}
      onOpen={(link) => open(task, link)}
    />
  );

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("tasks.title")}</PageTitle>
        <div className="mt-2 grid gap-3">
          <SegmentedControl
            label={t("tasks.title")}
            activeId={view}
            onSelect={(id) => setView(id as View)}
            items={[
              { id: "partner", label: t("tasks.partner"), badge: waiting("partner") },
              { id: "daily", label: t("tasks.daily"), badge: waiting("daily") },
              { id: "weekly", label: t("tasks.weekly"), badge: waiting("weekly") },
              { id: "achievements", label: t("tasks.achievements"), badge: waiting("achievement") },
            ]}
          />
          {!tasksAvailable() ? <InfoNotice text={t("tasks.guest")} /> : null}
        </div>

        {state.status === "loading" && tasksAvailable() ? <p className="mt-4 text-sm text-text-muted">{t("tasks.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("tasks.failed")} onRetry={() => void load()} /> : null}

        {state.status !== "ready" ? null : (
          // Ключ — вид: список монтируется заново, и лесенка появления
          // проигрывается при каждом переключении.
          <div key={view} className="mt-4">
            {view === "daily" || view === "weekly" ? <ResetLine period={view} /> : null}
            {partner ? <RestrictedPlaque kinds={PARTNER_RESTRICTION} className="mb-3" /> : null}
            {/* Под ограничением вкладка пуста не потому, что заданий нет: это говорит плашка. */}
            {tasks.length === 0 && (!partner || (networkRows === 0 && !partnerClosed)) ? <p className="text-sm text-text-muted">{t("tasks.empty")}</p> : null}
            {/* relative: строка сети, пока её задание не нарисовано, стоит невидимой поверх списка */}
            <div className="relative grid gap-2">
              {claimable.map((task, index) => row(task, index))}
              {partner ? <NetworkTasks items={networks} firstIndex={claimable.length} refresh={refresh} onCount={setNetworkRows} /> : null}
              {rest.map((task, index) => row(task, claimable.length + (partner ? networkRows : 0) + index))}
            </div>
          </div>
        )}
      </ContentColumn>
    </Screen>
  );
}

function ResetLine(props: { period: ResetPeriod }): ReactNode {
  // Время считается при открытии вида, без тикающего таймера: минутная
  // точность не стоит перерисовки экрана раз в секунду.
  const [resetIn] = useState(() => msUntilReset(Date.now(), props.period));
  return (
    <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted">
      <Clock size={14} aria-hidden="true" />
      {t("tasks.resetIn", { time: formatCountdown(resetIn) })}
    </p>
  );
}
