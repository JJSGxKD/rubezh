import { useEffect, useState, type ReactNode } from "react";
import { Bot, Check, Clock, Crown, Crosshair, ExternalLink, Hourglass, Megaphone, Play, Sparkles, Target } from "lucide-react";
import { Badge, Button, Card, ContentColumn, ErrorState, InfoNotice, PageTitle, ProgressBar, Screen, SegmentedControl } from "../../design-system/components";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/tasks";
import { loadBadges } from "../../state/badges-api";
import { track, useShell } from "../../state/shell";
import {
  TASK_LIMIT_REACHED,
  TASK_NOT_DONE,
  claimFailureKey,
  createTasksApi,
  isClaimable,
  isFeedTask,
  isOpenKind,
  openTaskLink,
  slotsText,
  sortTasks,
  taskImageUrl,
  tabOf,
  taskLink,
  tasksAvailable,
  type NetworkTaskItem,
  type TaskItem,
  type TaskTab,
} from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { formatCountdown, msUntilReset, type ResetPeriod } from "./schedule";
import { NetworkTasks } from "./network-tasks";
import { TaskImage } from "./task-image";
import { RewardChips, rewardText } from "./task-reward";

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

const ICONS: Partial<Record<string, ReactNode>> = {
  runs: <Play size={20} aria-hidden="true" />,
  kills: <Crosshair size={20} aria-hidden="true" />,
  survive_sec: <Hourglass size={20} aria-hidden="true" />,
  best_survival_sec: <Crown size={20} aria-hidden="true" />,
  run_level: <Sparkles size={20} aria-hidden="true" />,
  channel: <Megaphone size={20} aria-hidden="true" />,
  link: <ExternalLink size={20} aria-hidden="true" />,
  bot: <Bot size={20} aria-hidden="true" />,
};

/** Цели во времени считаются в секундах, а читаются минутами. */
const TIME_KINDS: ReadonlySet<string> = new Set(["survive_sec", "best_survival_sec"]);

const api = createTasksApi();

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
      setNotice({ taskId: task.id, text: t(claimFailureKey(response.code)) });
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
      claiming={claiming === task.id}
      notice={notice?.taskId === task.id ? notice.text : null}
      closed={closed.has(task.id)}
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
            {tasks.length === 0 && (!partner || networkRows === 0) ? <p className="text-sm text-text-muted">{t("tasks.empty")}</p> : null}
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

function TaskRow(props: {
  index: number;
  task: TaskItem;
  claiming: boolean;
  notice: string | null;
  /** места кончились, пока экран открыт: действовать больше нечем */
  closed: boolean;
  onClaim: () => void;
  onOpen: (link: string) => void;
}): ReactNode {
  const { task } = props;
  const claimable = isClaimable(task) && !props.closed;
  const link = taskLink(task);
  // Подписку выполняет не забег: её проверяет сервер по нажатию, поэтому
  // «Проверить» есть и у невыполненной цели. Ссылку и бота выполняет переход.
  const waitsAction = link !== null && !task.done && !props.closed;
  const opens = waitsAction && isOpenKind(task.kind);
  const name = achievementName(task);
  // Места считаются при отрисовке, без тикающего таймера: экран заданий
  // перечитывается при каждом открытии и после каждого действия.
  const place = props.closed ? null : slotsText(task.slots, Date.now());
  const title = task.title ?? name ?? goalText(task);
  const image = taskImageUrl(task.image, useShell.getState().capabilities.auth?.baseUrl);
  const hint = task.title === null && name !== null ? goalText(task) : (repeatHint(task) ?? null);

  return (
    <Card appearIndex={props.index} stripe={claimable ? "accent" : undefined}>
      <div className="flex items-center gap-3">
        <TaskImage
          src={image}
          fallback={
            <span
              className={[
                "inline-flex size-11 shrink-0 items-center justify-center rounded-md",
                task.done ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-muted",
              ].join(" ")}
            >
              {ICONS[task.kind] ?? <Target size={20} aria-hidden="true" />}
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-sm font-bold text-text">{title}</span>
            {task.claimed ? (
              <Badge tone="muted">
                <Check size={12} aria-hidden="true" />
                {t("tasks.claimed")}
              </Badge>
            ) : task.done ? (
              <Badge tone="accent">
                <Check size={12} aria-hidden="true" />
                {t("tasks.done")}
              </Badge>
            ) : null}
          </div>
          {hint === null ? null : <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
          {place === null ? null : <p className="mt-0.5 font-display text-xs font-semibold text-accent">{t(place.key, place.params)}</p>}
          {link === null ? (
            <div className="mt-2">
              <ProgressLine task={task} />
            </div>
          ) : null}
        </div>
        <RewardChips reward={task.reward} />
      </div>
      {/* Под строкой и во всю ширину: в правой колонке кнопка сжимала полосу
          прогресса до точки на узком телефоне. */}
      {claimable ? (
        <div className="mt-3">
          <Button block loading={props.claiming} onClick={props.onClaim}>
            {t("tasks.claim")}
          </Button>
        </div>
      ) : null}
      {opens ? (
        <div className="mt-3">
          <Button block onClick={() => props.onOpen(link)}>
            <ExternalLink size={18} aria-hidden="true" />
            {t(task.kind === "bot" ? "tasks.startBot" : "tasks.go")}
          </Button>
        </div>
      ) : null}
      {waitsAction && !opens ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => props.onOpen(link)}>
            {t("tasks.subscribe")}
          </Button>
          <Button loading={props.claiming} onClick={props.onClaim}>
            {t("tasks.check")}
          </Button>
        </div>
      ) : null}
      {props.notice === null ? null : <p className="mt-2 text-xs font-semibold text-text-muted">{props.notice}</p>}
    </Card>
  );
}

function ProgressLine(props: { task: TaskItem }): ReactNode {
  const { task } = props;
  const format = (value: number): string => (TIME_KINDS.has(task.kind) ? formatDuration(value) : formatNumber(value));
  const text = `${format(task.value)} / ${format(task.target)}`;

  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={task.value} max={task.target} height="thin" label={text} />
      <span aria-hidden="true" className="shrink-0 font-display text-xs tabular-nums text-text-muted">
        {text}
      </span>
    </div>
  );
}

/**
 * Повтор партнёрской подписки (Р82): награда за каждые сутки или неделю,
 * пока игрок подписан. Забрал — когда следующая; время считается при
 * отрисовке, без тикающего таймера, как у строки сброса.
 */
function repeatHint(task: TaskItem): string | null {
  if (tabOf(task) !== "partner" || task.period === "achievement") return null;
  // Число с единицей — неразрывно: «7 ч» не должно разъехаться по строкам.
  if (task.claimed) return t("tasks.repeat.next", { time: formatCountdown(msUntilReset(Date.now(), task.period)).replace(/(\d) /g, "$1\u00a0") });
  return t(task.period === "daily" ? "tasks.repeat.daily" : "tasks.repeat.weekly");
}

/** Имя достижения из словаря — у достижений по умолчанию; у своих из панели — заголовок каталога. */
function achievementName(task: TaskItem): string | null {
  const key = `achievement.${task.id}.name`;
  return task.period === "achievement" && hasTranslation(key) ? t(key) : null;
}

/**
 * Цель по виду — со склонением числа: `target` склоняет, `count` — то же число
 * с разрядами, как в полосе прогресса. Незнакомый вид без заголовка — просто
 * число цели.
 */
function goalText(task: TaskItem): string {
  const key = `task.kind.${task.kind}`;
  if (!hasTranslation(key)) return formatNumber(task.target);
  return t(key, { target: task.target, count: formatNumber(task.target), time: formatCountdown(task.target * 1000) });
}
