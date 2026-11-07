import { ValidationError } from "../../common/domain-error.js";
import { logTemplateOf, templateProblems } from "./destinations/postback-template.js";

/**
 * Правила, по которым адрес постбэка задают у ссылки и у партнёра (tasks/T-0070, docs/35-stage4-plan.md
 * Р86, Р96): одни для обоих, поэтому здесь, а не в двух сервисах. Чистые функции: ни базы, ни сети.
 */

/** Адрес и момент, с которого он действует по кликам; пусто — оба `null`, иначе оба заданы. */
export interface PostbackSetting {
  url: string | null;
  since: Date | null;
}

/** Адрес из тела запроса: пробелы по краям обрезаются, пустой — снятие (`null`). */
export function normalizePostbackUrl(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Адрес после проверки; `null` — адрес снимают. Не прошёл проверку — `ValidationError` с первой проблемой
 * словами, как её увидит человек в панели.
 */
export function checkedPostbackUrl(raw: string | null): string | null {
  const url = normalizePostbackUrl(raw);
  if (url === null) return null;
  const [problem] = templateProblems(url);
  if (problem !== undefined) throw new ValidationError(problem);
  return url;
}

/**
 * Что записать, когда адрес меняется на `url`. Первое задание адреса и смена `null → адрес` ставят момент
 * «сейчас»; смена адреса на другой момент не трогает — клики после первого задания остаются в силе; снятие
 * обнуляет оба поля. Прошлое не досылается: клики раньше момента адрес не получает.
 */
export function nextPostback(current: PostbackSetting, url: string | null, now: Date): PostbackSetting {
  if (url === null) return { url: null, since: null };
  return { url, since: current.url === null || current.since === null ? now : current.since };
}

/** Адрес для аудита и для тех, у кого нет права на правку: без запроса и фрагмента. */
export function postbackLogForm(url: string | null): string | null {
  return url === null ? null : logTemplateOf(url);
}
