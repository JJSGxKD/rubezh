import { useEffect, useState, type ReactNode } from "react";
import { Crown, ListChecks, Lock, Sparkles } from "lucide-react";
import type { RunResult } from "@bh/shared-types";
import { SectionTitle } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
// Подписи открытий — в словаре аккаунта: он приезжает с этим чанком.
import "../../i18n/account";
import { nextUnlockAfter } from "../../state/level-unlocks";
import { useMeta } from "../../state/meta";
import type { RunRewardView } from "../../state/progress";
import type { TaskItem } from "../../state/tasks-api";
import { goalText, levelGoalInput, pickNextGoals, type NextGoal } from "./death-next";

/**
 * Блок «Что дальше» под наградой за забег (tasks/T-0109): до трёх ближайших
 * целей. Появляется одним показом, когда награда пришла и задания ответили
 * (успехом или нет): ждать больше нечего, и кнопки в подвале не двигаются.
 * Правила целей — `death-next.ts`, здесь только запрос заданий и рисование.
 *
 * Задания читаем существующей ручкой `GET /api/v1/tasks`: серверная часть не
 * менялась. Модуль заданий грузится вместе с экраном заданий и в чанк смерти
 * статически не входит — только динамическим импортом (`pnpm budget`).
 */

type Tasks = "loading" | "failed" | TaskItem[];

const ICON: Record<NextGoal["kind"], typeof Crown> = { record: Crown, level: Sparkles, task: ListChecks, unlock: Lock };

export function DeathNext(props: { result: RunResult; isNewRecord: boolean; reward: RunRewardView | undefined; withTasks: boolean }): ReactNode {
  const { result, reward } = props;
  const best = useMeta((state) => state.best[result.difficultyId]);
  const settled = reward !== undefined && reward.status !== "pending";
  const [tasks, setTasks] = useState<Tasks>("loading");

  useEffect(() => {
    // Витрине компонентов и гостю сети нет: заданий не ждём.
    if (!settled || !props.withTasks) return;
    let alive = true;
    void (async () => {
      try {
        const { createTasksApi } = await import("../../state/tasks-api");
        const response = await createTasksApi().view();
        if (alive) setTasks(response.ok ? response.data.tasks : "failed");
      } catch {
        // Чанк заданий не приехал — блок обойдётся без цели «задание».
        if (alive) setTasks("failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [settled, props.withTasks]);

  if (!settled) return null;
  if (props.withTasks && tasks === "loading") return null;

  const level = levelGoalInput(reward);
  const goals = pickNextGoals({
    isNewRecord: props.isNewRecord,
    survivalSec: result.survivalSec,
    bestSec: best ?? null,
    level,
    tasks: Array.isArray(tasks) ? tasks : [],
    nextUnlock: level === null ? null : nextUnlockAfter(level.level),
  });
  if (goals.length === 0) return null;

  return (
    <section className="animate-pop-in rounded-lg border border-border bg-surface px-3 py-2.5" aria-label={t("run.next.title")}>
      <SectionTitle as="h3" spacing="">
        {t("run.next.title")}
      </SectionTitle>
      <ul className="mt-1.5 grid gap-1.5">
        {goals.map((goal) => {
          const Icon = ICON[goal.kind];
          return (
            <li key={goal.kind} className="flex items-start gap-2 text-[13px] leading-snug text-text">
              <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0">{goalText(goal)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
