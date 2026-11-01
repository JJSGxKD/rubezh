import { useEffect, useState, type ReactNode } from "react";
import { Clock } from "lucide-react";
import { ContentColumn, ErrorState, InfoNotice, PageTitle, Screen, SegmentedControl } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/tasks";
import { loadBadges } from "../../state/badges-api";
import { restrictionRefusal, useRestricted } from "../../state/restrictions";
import { track, useShell } from "../../state/shell";
import { rewardFeedback } from "../../state/ui-feedback";
import {
  TASK_LIMIT_REACHED,
  TASK_NOT_DONE,
  TASK_POINTS_NOT_REACHED,
  claimFailureKey,
  createTasksApi,
  isClaimable,
  isFeedTask,
  openTaskLink,
  pointsFailureKey,
  sortTasks,
  taskImageUrl,
  tabOf,
  tasksAvailable,
  type NetworkTaskItem,
  type PointsPeriod,
  type TaskItem,
  type TaskPoints,
  type TaskTab,
} from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { burstAt, RewardBurst, type Burst } from "../reward-burst";
import { ICON_RESOURCE, mainResource } from "../reward-burst-rules";
import { formatCountdown, msUntilReset, type ResetPeriod } from "./schedule";
import { BotMentionRows } from "./bot-mention-rows";
import { NetworkTasks } from "./network-tasks";
import { RestrictedPlaque } from "./restricted-plaque";
import { TaskPointsBar } from "./task-points";
import { readyIn } from "./task-points-rules";
import { TaskRow } from "./task-row";
import { rewardText } from "./task-reward";
import { TASK_TAB_OF, viewAfterLoad, type TasksView } from "./tasks-rules";

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
 *
 * На вкладках «День» и «Неделя» над списком — полоса очков с тремя ступенями
 * (T-0105, `task-points.tsx`): очки считает сервер по выполненным заданиям,
 * награду за ступень он же выдаёт. Старый сервер полосу не присылал — блока
 * тогда просто нет.
 */
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; tasks: TaskItem[]; networks: NetworkTaskItem[] };

const api = createTasksApi();
/** Партнёрские задания — свои и сетей — закрывает своё ограничение (WP44). */
const PARTNER_RESTRICTION = ["partner_tasks"];

export function TasksScreen(): ReactNode {
  // Пока игрок не выбрал сам — вкладка с наградой, иначе партнёрские, иначе
  // ежедневные: правило в tasks-rules.ts.
  const [chosen, setView] = useState<TasksView | null>(null);
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ taskId: string; text: string } | null>(null);
  const [burst, setBurst] = useState<Burst | null>(null);
  // Цели, места в которых кончились, пока экран открыт: строка остаётся с
  // объяснением, но без кнопок и остатка — со следующим открытием её не будет.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const close = (taskId: string): void => {
    setClosed((current) => new Set(current).add(taskId));
    setNotice({ taskId, text: t("tasks.limitReached") });
  };

  const [networkRows, setNetworkRows] = useState(0);

  // Полоса очков приходит с заданиями, но живёт отдельно: забор ступени меняет
  // её, не трогая список.
  const [points, setPoints] = useState<TaskPoints | null>(null);
  const [pointsBusy, setPointsBusy] = useState<number | null>(null);
  const [pointsNotice, setPointsNotice] = useState<{ period: PointsPeriod; text: string } | null>(null);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await api.view();
    if (!response.ok) return setState({ status: "failed" });
    const networks = response.data.networks ?? [];
    setState({ status: "ready", tasks: response.data.tasks, networks });
    setPoints(response.data.points ?? null);
    // Вкладка решается однажды, по первому ответу: задание сети уходит на паузу
    // посреди проверки, и экран не должен сам перескочить, пока игрок ждёт награду.
    const partner = networks.some((item) => item.offer !== null || (isFeedTask(item) && item.nextAt === null)) || response.data.tasks.some((task) => tabOf(task) === "partner");
    setView((current) => viewAfterLoad({ chosen: current, tasks: response.data.tasks, hasPartner: partner }));
  };

  /** Перечитать без «загрузки» на экране — за подтверждением задания сети. */
  const refresh = async (): Promise<NetworkTaskItem[] | null> => {
    const response = await api.view();
    if (!response.ok) return null;
    const networks = response.data.networks ?? [];
    setState({ status: "ready", tasks: response.data.tasks, networks });
    setPoints(response.data.points ?? null);
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
      else track("task_completed", { task: task.id, period: task.period, kind: task.kind, ...(isPoolTier(task.tier) ? { tier: task.tier } : {}) });
      setNotice({ taskId: task.id, text: t("tasks.got", { what: rewardText(response.data.credited) }) });
      // Значки вылетают из награды в строке задания — снимок до перерисовки:
      // забранное задание уходит вниз списка.
      const main = mainResource(response.data.credited);
      rewardFeedback(main === null ? null : ICON_RESOURCE[main.icon]);
      if (main !== null) setBurst(burstAt(document.querySelector(`[data-task-reward="${CSS.escape(task.id)}"]`), main.amount, main.icon));
      void loadWallet();
    }
    void loadBadges();
  };

  /**
   * Забрать награду за ступень очков (T-0105): по образцу `claim` — двойное
   * нажатие блокируется, отказ — строкой под полосой. «Очков не хватает» —
   * экран устарел (сменились сутки), поэтому задания и полоса перечитываются.
   */
  const claimPoints = async (period: PointsPeriod, step: number): Promise<void> => {
    if (pointsBusy !== null) return;
    setPointsBusy(step);
    setPointsNotice(null);
    const response = await api.claimPoints(period, step);
    setPointsBusy(null);
    if (!response.ok) {
      setPointsNotice({ period, text: t(pointsFailureKey(response.code)) });
      if (response.code === TASK_POINTS_NOT_REACHED) void refresh();
      return;
    }
    setPoints((current) => (current === null ? current : withStepClaimed(current, period, step)));
    if (response.data.claimed) {
      track("task_points_claimed", { period, step });
      setPointsNotice({ period, text: t("tasks.got", { what: rewardText(response.data.credited) }) });
      const main = mainResource(response.data.credited);
      rewardFeedback(main === null ? null : ICON_RESOURCE[main.icon]);
      if (main !== null) setBurst(burstAt(document.querySelector(`[data-points-reward="${String(step)}"]`), main.amount, main.icon));
      void loadWallet();
    }
    void loadBadges();
  };

  const all = state.status === "ready" ? state.tasks : [];
  const networks = state.status === "ready" ? state.networks : [];
  const view: TasksView = chosen ?? "daily";
  const tasks = sortTasks(all.filter((task) => tabOf(task) === TASK_TAB_OF[view]));
  // Порядок вкладки общий (WP13, часть 6): что можно забрать — первым,
  // задания сетей — сразу за ним, дальше — остальное.
  const claimable = tasks.filter(isClaimable);
  const rest = tasks.filter((task) => !isClaimable(task));
  const partner = view === "partner";
  const partnerClosed = useRestricted(PARTNER_RESTRICTION);
  // Знак на вкладке — сколько наград там ждёт: игрок видит их, не перебирая вкладки.
  // К наградам заданий вкладок «День» и «Неделя» прибавляются готовые ступени их полос.
  const waiting = (tab: TaskTab) =>
    all.filter((task) => tabOf(task) === tab && isClaimable(task)).length + (points === null ? 0 : tab === "daily" ? readyIn(points.daily) : tab === "weekly" ? readyIn(points.weekly) : 0);

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
        <BotMentionRows />
        <div className="mt-2 grid gap-3">
          <SegmentedControl track="view"
            label={t("tasks.title")}
            activeId={view}
            onSelect={(id) => setView(id as TasksView)}
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
            {(view === "daily" || view === "weekly") && points !== null ? (
              <div className="mb-3">
                <TaskPointsBar
                  period={view}
                  bar={points[view]}
                  claiming={pointsBusy}
                  notice={pointsNotice?.period === view ? pointsNotice.text : null}
                  onClaim={(step) => void claimPoints(view, step)}
                />
              </div>
            ) : null}
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
        {burst === null ? null : <RewardBurst key={burst.key} burst={burst} onDone={() => setBurst(null)} />}
      </ContentColumn>
    </Screen>
  );
}

/** Ступень пула ротации в событии — только известная серверу: словарь событий другой не примет. */
function isPoolTier(tier: string | null | undefined): tier is "easy" | "medium" | "hard" {
  return tier === "easy" || tier === "medium" || tier === "hard";
}

/** Полоса после забора: ступень становится забранной, остальное как было. */
function withStepClaimed(points: TaskPoints, period: PointsPeriod, step: number): TaskPoints {
  const bar = points[period];
  return { ...points, [period]: { ...bar, steps: bar.steps.map((candidate) => (candidate.points === step ? { ...candidate, state: "claimed" as const } : candidate)) } };
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
