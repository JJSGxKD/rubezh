import type { XrayCompatibility, XrayCoreView, XrayLastRun } from "../../api/xray-core";
import { formatTime } from "../../format";

/**
 * Тексты вкладки «Ядро Xray» (docs/35-stage4-plan.md Р202, tasks/T-0418).
 * Решения принимает сервер — совместимость и причину закрытой кнопки он уже
 * назвал кодом; здесь коды только переводятся в слова. Незнакомый код
 * показывается как есть: пустая строка скрыла бы, что сервер новее панели.
 */

export type Tone = "success" | "warning" | "danger" | "neutral";

export interface CompatibilityText {
  tone: Tone;
  label: string;
  detail: string | null;
}

/** Причина несовместимости приходит только у `blocked`; у незнакомого вида её нет. */
function reasonOf(compatibility: XrayCompatibility): string | null {
  return "reason" in compatibility && typeof compatibility.reason === "string" ? compatibility.reason : null;
}

export function compatibilityText(compatibility: XrayCompatibility): CompatibilityText {
  switch (compatibility.kind) {
    case "tested":
      return { tone: "success", label: "Проверено", detail: "Наш конфиг принят этой версией" };
    case "untested":
      return { tone: "warning", label: "Не проверено", detail: "Проверит CI в PR обновления" };
    case "blocked":
      return { tone: "danger", label: "Перейти нельзя, нужно обновить код", detail: reasonOf(compatibility) };
    case "older":
      return { tone: "neutral", label: "Старше проверенных", detail: "Обновляться на неё незачем" };
    case "unknown":
      return { tone: "neutral", label: "Версия не распознана", detail: null };
    default:
      return { tone: "neutral", label: compatibility.kind, detail: null };
  }
}

const BLOCKED_TEXTS: Readonly<Record<string, string>> = {
  no_release: "Свежий выпуск не получен",
  blocked: "Перейти нельзя, нужно обновить код",
  older: "Выпуск старше проверенных версий",
  up_to_date: "Ядро уже этой версии",
  in_code: "Версия уже в коде — уедет с ближайшим выпуском",
  running: "Обновление уже идёт",
  no_token: "Нет ключа github.xray-update",
};

/** Почему кнопка «Обновить» закрыта; `lockedUntil` — ISO, время выводится в поясе браузера. */
export function blockedText(code: string, lockedUntil: string | null): string {
  if (code === "locked") {
    return lockedUntil === null ? "Запускали недавно — подождите немного" : `Запускали недавно — снова можно в ${formatTime(lockedUntil)}`;
  }
  return BLOCKED_TEXTS[code] ?? code;
}

/** Итог последнего запуска workflow одним словом и тоном. */
export function runText(run: Pick<XrayLastRun, "status" | "active" | "conclusion">): { tone: Tone; label: string } {
  if (run.active) return { tone: "warning", label: "идёт" };
  switch (run.conclusion) {
    case "success":
      return { tone: "success", label: "PR открыт" };
    case "failure":
      return { tone: "danger", label: "упал — проверка конфига не прошла или ошибка запуска, смотрите в GitHub" };
    case "cancelled":
      return { tone: "neutral", label: "отменён" };
    default:
      return { tone: "neutral", label: run.conclusion ?? run.status };
  }
}

/** Диапазон версий, на которых наш конфиг проверен. */
export function testedRangeText(min: string, max: string): string {
  return min === max ? `Проверена версия ${min}` : `Проверены версии ${min}–${max}`;
}

/** Замечание к запущенному ядру: устаревшее требует выпуска, более новое — просто сведение. */
export function runningNote(running: Pick<XrayCoreView["running"], "compatibility">): { tone: "warning" | "info"; text: string } | null {
  switch (running.compatibility?.kind) {
    case "older":
      return { tone: "warning", text: "Запущенное ядро старше проверенных версий — выкатите выпуск" };
    case "untested":
      return { tone: "info", text: "Запущенное ядро новее проверенных версий" };
    default:
      return null;
  }
}
