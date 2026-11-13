import { z } from "zod";
import type { ContentCheckRecord } from "./content.repository.js";

/**
 * Когда проверка годится для публикации (docs/19-content-admin.md §4.3,
 * tasks/T-0306): те же шаги, что рельсы панели (`apps/admin/.../check-rules.ts`),
 * только на сервере — кнопку панели можно обойти запросом, а публикацию нельзя.
 *
 * Отчёт воркера пришёл из Redis через базу и разбирается схемой, а не
 * приводится: форма чужая — публиковать нельзя, а не «наверное, зелёное».
 */

const problemSchema = z.object({ path: z.string(), message: z.string() });
const reportSchema = z.looseObject({
  schemaProblems: z.array(problemSchema),
  contentProblems: z.array(problemSchema),
  report: z
    .looseObject({
      timeout: z.boolean(),
      corridors: z.array(z.looseObject({ title: z.string(), draft: z.object({ value: z.number(), verdict: z.enum(["in", "below", "above"]) }).nullable() })),
    })
    .nullable(),
});

const RERUN = "запустите «Проверить» снова";

/** Хвост «(и ещё N)» у списка, из которого названа только первая запись. */
function more(count: number): string {
  return count > 1 ? ` (и ещё ${String(count - 1)})` : "";
}

/**
 * Почему по этой проверке публиковать нельзя; `null` — можно.
 *
 * `forSnapshot` — живая проверка того самого снимка, который публикуется (по
 * его отпечатку); `latest` — последняя проверка черновика вообще, она нужна
 * лишь чтобы отличить «проверки не было» от «черновик менялся после неё».
 *
 * «У края» рельсам панели не мешает, и здесь тоже: берётся вердикт воркера
 * («в коридоре»), а не запас до границы. Метрика, которую не из чего было
 * считать, тоже не мешает, пока посчитана хоть одна, — как у рельсов.
 */
export function publishBlockReason(input: { latest: ContentCheckRecord | null; forSnapshot: ContentCheckRecord | null }): string | null {
  const { latest, forSnapshot } = input;
  if (forSnapshot === null) {
    if (latest === null) return "Проверки черновика не было — запустите «Проверить» и дождитесь зелёного итога";
    if (latest.status === "failed") return `Последняя проверка не посчиталась — ${RERUN}`;
    return `Черновик менялся после последней проверки — ${RERUN}`;
  }
  if (forSnapshot.status === "queued") return "Проверка ещё идёт — дождитесь итога";
  if (forSnapshot.status === "failed") return `Проверка не посчиталась — ${RERUN}`;
  if (forSnapshot.status === "timeout") return "Симуляция не уложилась в предел времени — публиковать по такой проверке нельзя";

  const parsed = reportSchema.safeParse(forSnapshot.report);
  if (!parsed.success) return `Отчёт проверки не разобрался — ${RERUN}`;
  const { schemaProblems, contentProblems, report } = parsed.data;
  const firstSchema = schemaProblems[0];
  if (firstSchema !== undefined) return `Схема не сходится: ${firstSchema.path} — ${firstSchema.message}${more(schemaProblems.length)}`;
  const firstContent = contentProblems[0];
  if (firstContent !== undefined) return `Проверки контента: ${firstContent.path} — ${firstContent.message}${more(contentProblems.length)}`;
  if (report === null) return `В отчёте нет симуляции — ${RERUN}`;
  if (report.timeout) return "Симуляция не уложилась в предел времени — публиковать по такой проверке нельзя";

  const outside = report.corridors.filter((line) => line.draft !== null && line.draft.verdict !== "in");
  const first = outside[0];
  if (first !== undefined) return `Метрика вне коридора: ${first.title}${more(outside.length)}`;
  if (!report.corridors.some((line) => line.draft !== null)) return "В отчёте нет ни одной посчитанной метрики симуляции — публиковать не по чему";
  return null;
}
