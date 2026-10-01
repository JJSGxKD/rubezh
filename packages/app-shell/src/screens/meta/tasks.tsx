import { useEffect, useState, type ReactNode } from "react";
import { Bot, Check, Clock, Crown, Crosshair, Diamond, ExternalLink, Hourglass, Megaphone, Play, Sparkles, Target } from "lucide-react";
import { Badge, Button, Card, ContentColumn, ErrorState, InfoNotice, PageTitle, ProgressBar, Screen, SegmentedControl } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/tasks";
import { loadBadges } from "../../state/badges-api";
import { track } from "../../state/shell";
import {
  TASK_NOT_DONE,
  claimFailureKey,
  createTasksApi,
  isClaimable,
  isOpenKind,
  openTaskLink,
  sortTasks,
  tabOf,
  taskLink,
  tasksAvailable,
  type TaskItem,
  type TaskReward,
  type TaskTab,
} from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { formatCountdown, msUntilReset, type ResetPeriod } from "./schedule";

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
 */
type View = "daily" | "weekly" | "achievements" | "partner";
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; tasks: TaskItem[] };

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
  const [view, setView] = useState<View>("daily");
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ taskId: string; text: string } | null>(null);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await api.view();
    setState(response.ok ? { status: "ready", tasks: response.data.tasks } : { status: "failed" });
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
      setNotice({ taskId: task.id, text: t(claimFailureKey(response.code)) });
      if (response.code === TASK_NOT_DONE) void load();
      return;
    }
    setState({ status: "ready", tasks: response.data.tasks });
    if (response.data.claimed) {
      if (task.period === "achievement") track("achievement_unlocked", { achievement: task.id, kind: task.kind });
      else track("task_completed", { task: task.id, period: task.period, kind: task.kind });
      setNotice({ taskId: task.id, text: t("tasks.got", { what: rewardText(response.data.credited) }) });
      void loadWallet();
    }
    void loadBadges();
  };

  const all = state.status === "ready" ? state.tasks : [];
  const tasks = sortTasks(all.filter((task) => tabOf(task) === TAB_OF[view]));
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
      if (response.ok) setState({ status: "ready", tasks: response.data.tasks });
    });
  };

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
              { id: "daily", label: t("tasks.daily"), badge: waiting("daily") },
              { id: "weekly", label: t("tasks.weekly"), badge: waiting("weekly") },
              { id: "achievements", label: t("tasks.achievements"), badge: waiting("achievement") },
              { id: "partner", label: t("tasks.partner"), badge: waiting("partner") },
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
            {tasks.length === 0 ? <p className="text-sm text-text-muted">{t("tasks.empty")}</p> : null}
            <div className="grid gap-2">
              {tasks.map((task, index) => (
                <TaskRow
                  key={task.id}
                  index={index}
                  task={task}
                  claiming={claiming === task.id}
                  notice={notice?.taskId === task.id ? notice.text : null}
                  onClaim={() => void claim(task)}
                  onOpen={(link) => open(task, link)}
                />
              ))}
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

function TaskRow(props: { index: number; task: TaskItem; claiming: boolean; notice: string | null; onClaim: () => void; onOpen: (link: string) => void }): ReactNode {
  const { task } = props;
  const claimable = isClaimable(task);
  const link = taskLink(task);
  // Подписку выполняет не забег: её проверяет сервер по нажатию, поэтому
  // «Проверить» есть и у невыполненной цели. Ссылку и бота выполняет переход.
  const waitsAction = link !== null && !task.done;
  const opens = waitsAction && isOpenKind(task.kind);
  const name = achievementName(task);
  const title = task.title ?? name ?? goalText(task);
  const hint = task.title === null && name !== null ? goalText(task) : null;

  return (
    <Card appearIndex={props.index} stripe={claimable ? "accent" : undefined}>
      <div className="flex items-center gap-3">
        <span
          className={[
            "inline-flex size-11 shrink-0 items-center justify-center rounded-md",
            task.done ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-muted",
          ].join(" ")}
        >
          {ICONS[task.kind] ?? <Target size={20} aria-hidden="true" />}
        </span>
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

/** Награда значками: монеты, самоцветы и осколки различаются и формой, и цветом (§4.4). */
function RewardChips(props: { reward: TaskReward }): ReactNode {
  const { coins, gems, shards } = props.reward;
  return (
    <span role="img" aria-label={rewardText(props.reward)} className="flex flex-col items-end gap-1">
      {coins > 0 ? <Chip icon={<CoinIcon size={16} />} amount={coins} /> : null}
      {gems > 0 ? <Chip icon={<GemIcon size={16} />} amount={gems} /> : null}
      {shards > 0 ? <Chip icon={<Diamond size={16} className="text-info" aria-hidden="true" />} amount={shards} /> : null}
    </span>
  );
}

function Chip(props: { icon: ReactNode; amount: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      {props.icon}
      <span className="font-display text-sm font-bold tabular-nums text-text">{formatNumber(props.amount)}</span>
    </span>
  );
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

function rewardText(reward: TaskReward): string {
  const parts = (["coins", "gems", "shards"] as const)
    .filter((resource) => reward[resource] > 0)
    .map((resource) => t(`task.reward.${resource}`, { amount: formatNumber(reward[resource]), n: reward[resource] }));
  return parts.join(t("tasks.and"));
}
