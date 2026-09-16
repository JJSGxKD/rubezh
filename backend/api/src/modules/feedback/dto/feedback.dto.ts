import { z } from "zod";

/**
 * Отзыв игрока с формы обратной связи. Данные с границы системы и разбираются
 * схемой целиком.
 *
 * Состав опроса задаёт клиент (`shared-types`, `FEEDBACK_QUESTIONS`), а сервер
 * проверяет **форму**, а не смысл: ключ и вариант — короткие слаги, пар
 * немного. Так вопрос можно добавить, не выкатывая бэкенд, и при этом в базу
 * не попадёт ни длинная строка, ни сотня полей.
 */

/** Потолок свободного текста; столько же держит колонка в базе. */
export const FEEDBACK_TEXT_MAX = 2000;

/** Слаг вопроса или варианта: латиница, цифры и подчёркивание, как `keepPlaying`. */
const slug = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "ключ и вариант — короткие слаги латиницей");

export const submitFeedbackSchema = z.object({
  installId: z.string().min(1).max(64),
  appVersion: z.string().min(1).max(64),
  platform: z.enum(["telegram", "max", "vk", "web"]),
  /** сколько забегов сыграно к моменту отзыва: новичок и ветеран весят разное */
  runs: z.number().int().nonnegative().max(1_000_000),
  answers: z.record(slug, slug).refine((value) => Object.keys(value).length <= 8, {
    message: "ответов не больше восьми",
  }),
  text: z.string().max(FEEDBACK_TEXT_MAX),
});

export type SubmitFeedback = z.infer<typeof submitFeedbackSchema>;
