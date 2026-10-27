import { isKnownOutcome, type BotMentionTask, type BotMentionView } from "../../state/bot-mention-api";

/**
 * Правила блока «юзернейм бота» на экране заданий (tasks/T-0160): чистые
 * функции без React. Клиент выбирает текст по ответу сервера и ничего не
 * считает.
 */

/** Виды в том порядке, в каком их показывают. */
const KINDS = ["name", "bio"] as const;

/**
 * Показываемые виды. Нет юзернейма бота — у площадки заданий нет, и блока тоже;
 * незнакомый вид сервера новее клиента молча пропускается.
 */
export function visibleTasks(view: BotMentionView): BotMentionTask[] {
  if (view.botUsername === null) return [];
  const shown: BotMentionTask[] = [];
  for (const kind of KINDS) {
    const task = view.tasks.find((candidate) => candidate.kind === kind);
    if (task !== undefined) shown.push(task);
  }
  return shown;
}

/** Строка состояния под описанием; `null` — не начато или проверок не было. */
export function statusKey(task: BotMentionTask): string | null {
  if (!task.started) return null;
  switch (task.lastResult) {
    case "present":
      return task.rewardedToday ? "botMention.status.rewarded" : null;
    case "absent":
      return `botMention.status.absent.${task.kind}`;
    // Пустое и закрытое bio неразличимы: один исход и одна фраза.
    case "hidden":
      return "botMention.status.hidden";
    case "unavailable":
      return "botMention.status.unavailable";
    default:
      return null;
  }
}

/** Подпись кнопки; `null` — кнопки нет: награда за сутки получена. */
export function buttonKey(task: BotMentionTask): string | null {
  if (task.rewardedToday) return null;
  return task.started ? "botMention.check" : "botMention.start";
}

/** Сообщение под кнопкой после ответа; исход, которого клиент не знает, — «не получилось». */
export function outcomeKey(outcome: string): string {
  return isKnownOutcome(outcome) ? `botMention.outcome.${outcome}` : "botMention.outcome.failed";
}
