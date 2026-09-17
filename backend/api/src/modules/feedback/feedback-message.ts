/**
 * Отзыв игрока сообщением в чат администраторов.
 *
 * Подписи вопросов и вариантов — здесь, на сервере, и только для чата: состав
 * опроса задаёт клиент, поэтому неизвестный ключ показывается как есть. Это
 * лучше, чем молчать о нём: в чате сразу видно, что добавился вопрос, для
 * которого никто не написал подписи.
 */

const LABELS: Record<string, string> = {
  difficulty: "Сложность",
  "difficulty.easy": "слишком легко",
  "difficulty.fine": "в самый раз",
  "difficulty.hard": "слишком трудно",
  liked: "Больше всего понравилось",
  "liked.fight": "бой",
  "liked.upgrades": "прокачка",
  "liked.look": "как выглядит",
  "liked.nothing": "ничего не зацепило",
  keepPlaying: "Будет играть ещё",
  "keepPlaying.yes": "да",
  "keepPlaying.maybe": "может быть",
  "keepPlaying.no": "нет",
};

export interface FeedbackMessage {
  answers: Record<string, string>;
  text: string;
  runs: number;
  platformUserId: string | null;
}

export function feedbackMessage(feedback: FeedbackMessage): string {
  const lines = ["Отзыв игрока", ""];
  for (const [question, option] of Object.entries(feedback.answers)) {
    lines.push(`${LABELS[question] ?? question}: ${LABELS[`${question}.${option}`] ?? option}`);
  }
  if (feedback.text !== "") {
    if (lines.length > 2) lines.push("");
    lines.push(feedback.text);
  }

  lines.push("");
  const who = feedback.platformUserId === null ? "без Telegram ID" : `id ${feedback.platformUserId}`;
  lines.push(`Забегов сыграно: ${String(feedback.runs)} · ${who}`);
  return lines.join("\n");
}
