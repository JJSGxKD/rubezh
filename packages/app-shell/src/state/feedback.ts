import { FEEDBACK_QUESTIONS, FEEDBACK_TEXT_MAX, type FeedbackAnswers } from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import { useInstall } from "./install";
import { useMeta } from "./meta";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Обратная связь от игрока (docs/29-admin-panel.md §6): три быстрых вопроса и
 * поле для пожеланий. Уходит на `POST /api/v1/feedback`, оттуда — в чат
 * администраторов и в базу.
 *
 * Отзыв уходит и без подписи запуска: подпись лишь добавляет Telegram ID,
 * чтобы на отзыв можно было ответить. Отправленный отзыв помнится на
 * устройстве — карточка на главной перестаёт звать, пока игрок не сыграет
 * ещё; спрашивать одно и то же каждый запуск незачем.
 */

const SENT_KEY = "bh.feedback.v1.sent";

/** Сколько ждать ответа: форма короткая, и игрок смотрит на кнопку. */
const TIMEOUT_MS = 10_000;

/** Через сколько новых забегов снова предлагать отзыв. */
const ASK_AGAIN_AFTER_RUNS = 10;

export type FeedbackFailure = "offline" | "rejected" | "limited" | "unavailable";

const schema = z.object({ atRuns: z.number(), at: z.number() });
const responseSchema = z.object({ data: z.object({ feedbackId: z.string() }) });

export interface FeedbackStore {
  /** после какого числа забегов отзыв уже отправляли; `null` — ни разу */
  sentAtRuns: number | null;
  sending: boolean;
  hydrate(): void;
  /** `null` — отзыв ушёл; иначе причина, которую показываем игроку */
  send(answers: FeedbackAnswers, text: string): Promise<FeedbackFailure | null>;
}

export const useFeedback = create<FeedbackStore>((set) => ({
  sentAtRuns: null,
  sending: false,

  hydrate(): void {
    set({ sentAtRuns: value().read()?.atRuns ?? null });
  },

  async send(answers, text): Promise<FeedbackFailure | null> {
    set({ sending: true });
    try {
      const failure = await post(answers, text.slice(0, FEEDBACK_TEXT_MAX));
      if (failure !== null) return failure;

      const runs = useMeta.getState().runs;
      value().write({ atRuns: runs, at: Date.now() });
      set({ sentAtRuns: runs });
      track("feedback_sent", {
        answers: Object.keys(answers).length,
        hasText: text.trim() !== "",
        runs,
      });
      return null;
    } finally {
      set({ sending: false });
    }
  },
}));

/** Звать ли игрока оставить отзыв: после первого забега и раз в десять забегов. */
export function shouldAskFeedback(runs: number, sentAtRuns: number | null): boolean {
  if (runs < 1) return false;
  return sentAtRuns === null || runs - sentAtRuns >= ASK_AGAIN_AFTER_RUNS;
}

/** Вопросы опроса — из общего словаря: тексты берутся по ключам в i18n. */
export function feedbackQuestions(): typeof FEEDBACK_QUESTIONS {
  return FEEDBACK_QUESTIONS;
}

async function post(answers: FeedbackAnswers, text: string): Promise<FeedbackFailure | null> {
  const { capabilities, adapter, build } = useShell.getState();
  if (capabilities.telemetry === undefined) return "unavailable";

  const url = `${capabilities.telemetry.baseUrl.replace(/\/+$/, "")}/api/v1/feedback`;
  const launch = adapter.signedLaunchData();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(launch === null || launch === "" ? {} : { authorization: `tma ${launch}` }),
      },
      body: JSON.stringify({
        installId: useInstall.getState().installId,
        appVersion: build.version,
        platform: build.platform,
        runs: useMeta.getState().runs,
        answers,
        text,
      }),
      signal: controller.signal,
    });
  } catch {
    // Обрыв сети и таймаут игроку одинаковы: он нажмёт «отправить» ещё раз.
    return "offline";
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 400 || response.status === 413) return "rejected";
  if (response.status === 429) return "limited";
  if (!response.ok) return "unavailable";

  try {
    return responseSchema.safeParse(await response.json()).success ? null : "unavailable";
  } catch {
    return "unavailable";
  }
}

function value(): ReturnType<typeof createPersistedValue<{ atRuns: number; at: number } | null>> {
  return createPersistedValue<{ atRuns: number; at: number } | null>({
    storage: useShell.getState().storage,
    key: SENT_KEY,
    schema: z.nullable(schema) as z.ZodMiniType<{ atRuns: number; at: number } | null>,
    fallback: null,
    onBroken: (key, reason) => reportError("feedback", `${key}: ${reason}`),
  });
}
