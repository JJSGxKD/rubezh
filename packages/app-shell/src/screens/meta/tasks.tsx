import { useState, type ReactNode } from "react";
import { Check, Clock, Crown, Crosshair, Flame, Hourglass, Play, Sparkles } from "lucide-react";
import {
  Badge,
  Card,
  ContentColumn,
  ProgressBar,
  Screen,
  SegmentedControl,
  StubNotice,
} from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";
import { useMeta } from "../../state/meta";
import { RewardChip } from "./reward";
import { formatCountdown, msUntilReset, type ResetPeriod } from "./schedule";
import {
  ACHIEVEMENTS,
  DAILY_TASKS,
  WEEKLY_TASKS,
  achievementProgress,
  type TaskDef,
  type TaskIcon,
} from "./stub-content";

/**
 * «Задания»: ежедневные, недельные и достижения
 * (docs/27-design-system-and-app-shell.md §6).
 *
 * Заглушка, но не пустая: задания нарисованы как настоящие, а прогресс
 * достижений, который уже можно посчитать по сохранённому на устройстве, —
 * настоящий. Награды не выдаются: их выдачу будет решать сервер
 * (docs/07-monetization-and-ads.md §7).
 */
type View = "daily" | "weekly" | "achievements";

const ICONS: Record<TaskIcon, ReactNode> = {
  runs: <Play size={20} aria-hidden="true" />,
  kills: <Crosshair size={20} aria-hidden="true" />,
  survive: <Hourglass size={20} aria-hidden="true" />,
  upgrades: <Sparkles size={20} aria-hidden="true" />,
  elites: <Flame size={20} aria-hidden="true" />,
  record: <Crown size={20} aria-hidden="true" />,
};

export function TasksScreen(): ReactNode {
  const [view, setView] = useState<View>("daily");

  return (
    <Screen title={t("tasks.title")}>
      <ContentColumn>
        <div className="mt-2 grid gap-3">
          <SegmentedControl
            label={t("tasks.title")}
            activeId={view}
            onSelect={(id) => setView(id as View)}
            items={[
              { id: "daily", label: t("tasks.daily") },
              { id: "weekly", label: t("tasks.weekly") },
              { id: "achievements", label: t("tasks.achievements") },
            ]}
          />
          <StubNotice text={t("tasks.stub")} />
        </div>

        {/* Ключ — вид: список монтируется заново, и лесенка появления
            проигрывается при каждом переключении. */}
        <div key={view} className="mt-4">
          {view === "achievements" ? (
            <AchievementList />
          ) : (
            <TaskList period={view} tasks={view === "daily" ? DAILY_TASKS : WEEKLY_TASKS} />
          )}
        </div>
      </ContentColumn>
    </Screen>
  );
}

function TaskList(props: { period: ResetPeriod; tasks: readonly TaskDef[] }): ReactNode {
  // Время считается при открытии вида, без тикающего таймера: минутная
  // точность не стоит перерисовки экрана раз в секунду.
  const [resetIn] = useState(() => msUntilReset(Date.now(), props.period));

  return (
    <>
      <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted">
        <Clock size={14} aria-hidden="true" />
        {t("tasks.resetIn", { time: formatCountdown(resetIn) })}
      </p>
      <div className="grid gap-2">
        {props.tasks.map((task, index) => (
          <TaskRow
            key={task.id}
            index={index}
            icon={ICONS[task.icon]}
            title={t(task.titleKey, { target: task.target })}
            progress={
              <ProgressLine
                value={0}
                target={task.target}
                valueLabel="0"
                targetLabel={formatNumber(task.target)}
              />
            }
            reward={<RewardChip reward={task.reward} />}
          />
        ))}
      </div>
    </>
  );
}

function AchievementList(): ReactNode {
  const runs = useMeta((state) => state.runs);
  const bestSurvivalSec = useMeta((state) => state.bestSurvivalSec);

  return (
    <div className="grid gap-2">
      {ACHIEVEMENTS.map((achievement, index) => {
        const progress = achievementProgress(achievement, { runs, bestSurvivalSec });
        const time = achievement.metric === "bestSurvivalSec";
        const format = (value: number): string => (time ? formatDuration(value) : String(value));

        return (
          <TaskRow
            key={achievement.id}
            index={index}
            icon={ICONS[achievement.icon]}
            done={progress.done}
            title={t(`achievement.${achievement.id}.name`)}
            hint={t(`achievement.${achievement.id}.description`)}
            progress={
              <ProgressLine
                value={progress.value}
                target={progress.target}
                valueLabel={format(progress.value)}
                targetLabel={format(progress.target)}
              />
            }
            reward={<RewardChip reward={achievement.reward} />}
          />
        );
      })}
    </div>
  );
}

function TaskRow(props: {
  index: number;
  icon: ReactNode;
  title: string;
  hint?: string;
  done?: boolean;
  progress: ReactNode;
  reward: ReactNode;
}): ReactNode {
  const done = props.done === true;

  return (
    <Card appearIndex={props.index} stripe={done ? "accent" : undefined}>
      <div className="flex items-center gap-3">
        <span
          className={[
            "inline-flex size-11 shrink-0 items-center justify-center rounded-md",
            done ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-muted",
          ].join(" ")}
        >
          {props.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-sm font-bold text-text">{props.title}</span>
            {done ? (
              <Badge tone="accent">
                <Check size={12} aria-hidden="true" />
                {t("tasks.done")}
              </Badge>
            ) : null}
          </div>
          {props.hint === undefined ? null : (
            <p className="mt-0.5 text-xs text-text-muted">{props.hint}</p>
          )}
          <div className="mt-2">{props.progress}</div>
        </div>
        {props.reward}
      </div>
    </Card>
  );
}

function ProgressLine(props: {
  value: number;
  target: number;
  valueLabel: string;
  targetLabel?: string;
}): ReactNode {
  const text = `${props.valueLabel} / ${props.targetLabel ?? String(props.target)}`;

  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={props.value} max={props.target} height="thin" label={text} />
      <span aria-hidden="true" className="shrink-0 font-display text-xs tabular-nums text-text-muted">
        {text}
      </span>
    </div>
  );
}
