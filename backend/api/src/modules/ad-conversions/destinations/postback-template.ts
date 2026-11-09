import { isInternalHostname } from "./public-address.js";

/**
 * Шаблон адреса постбэка (tasks/T-0070, docs/35-stage4-plan.md Р86, Р96): адрес с макросами, который
 * задают у ссылки или у партнёра. Проверка идёт при сохранении (`templateProblems`) и повторяется при
 * каждой отправке: правила могли ужесточиться, а адрес — остаться прежним. Подстановка (`fillTemplate`)
 * кодирует значения в один проход, поэтому значение, похожее на макрос, повторно не раскрывается.
 */

export const POSTBACK_MACROS = ["click_id", "sub1", "sub2", "sub3", "sub4", "sub5", "event", "event_id", "amount", "currency"] as const;
export type PostbackMacro = (typeof POSTBACK_MACROS)[number];

/** Длина шаблона, как в колонке `postback_url`. */
export const POSTBACK_URL_MAX = 1_024;
/** Длина адреса после подстановки: значения макросов делают его длиннее шаблона. */
export const POSTBACK_FILLED_MAX = 2_048;

const MACRO = /\{([^{}]*)\}/g;
const MACRO_LIST = "{click_id}, {sub1}…{sub5}, {event}, {event_id}, {amount}, {currency}";

/** Образцы значений для проверки: форма адреса от них не зависит, важно лишь, что подстановка собирается. */
const SAMPLE_VALUES: Readonly<Record<PostbackMacro, string>> = {
  click_id: "sample",
  sub1: "sample",
  sub2: "sample",
  sub3: "sample",
  sub4: "sample",
  sub5: "sample",
  event: "registration",
  event_id: "00000000-0000-4000-8000-000000000000",
  amount: "0",
  currency: "XTR",
};

function isMacro(name: string): name is PostbackMacro {
  return (POSTBACK_MACROS as readonly string[]).includes(name);
}

/** Использует ли шаблон макрос: так назначение узнаёт, нужен ли ему `click_id` из клика. */
export function usesMacro(template: string, macro: PostbackMacro): boolean {
  return template.includes(`{${macro}}`);
}

/** Есть ли у `хост[:порт]` порт: для IPv6 в скобках двоеточия внутри скобок портом не считаются. */
function hasPort(hostPort: string): boolean {
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    return close >= 0 && hostPort.charAt(close + 1) === ":";
  }
  return hostPort.includes(":");
}

/**
 * Что не так с шаблоном — тексты для человека; пустой список — годится. Структурные ошибки (пустой, длинный,
 * не https) возвращаются сразу и одни: дальше разбирать нечего. Имя сайта — часть до первого `/`, `?`, `#`
 * после `https://`; то, что строка разбирается и в итоге ведёт на публичный адрес, проверяется по разобранному
 * адресу с образцами вместо макросов.
 */
export function templateProblems(template: string): string[] {
  if (template.trim() === "") return ["Адрес пустой"];
  if (template.length > POSTBACK_URL_MAX) return [`Адрес длиннее ${String(POSTBACK_URL_MAX)} знаков`];
  if (!/^https:\/\//i.test(template)) return ["Адрес должен начинаться с https://"];
  // Пробелы и управляющие знаки: разбор адреса молча выбросил бы часть из них.
  if (/[\u0000- \u007f-\u009f]/.test(template)) return ["Адрес не разбирается"];

  const problems: string[] = [];
  const unknown = new Set<string>();
  for (const match of template.matchAll(MACRO)) {
    const name = match[1] ?? "";
    if (!isMacro(name)) unknown.add(name);
  }
  for (const name of unknown) problems.push(`Макрос {${name}} неизвестен. Доступны: ${MACRO_LIST}`);

  const authority = template.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
  if (/[{}]/.test(authority)) problems.push("Макросы нельзя ставить в имя сайта");
  const at = authority.lastIndexOf("@");
  if (at >= 0) problems.push("В адресе нельзя указывать логин и пароль");
  if (hasPort(authority.slice(at + 1))) problems.push("Порт в адресе не поддерживается");
  if (problems.length > 0) return problems;

  // Скобка без пары — опечатка в макросе: сервер получил бы её закодированной.
  if (/[{}]/.test(template.replace(MACRO, ""))) return ["Адрес не разбирается"];

  let url: URL;
  try {
    url = fillTemplate(template, SAMPLE_VALUES);
  } catch {
    return ["Адрес не разбирается"];
  }
  // Разбор мог увидеть то, чего не увидела строка (обратная косая черта вместо прямой): проверяем и его итог.
  if (url.protocol !== "https:") return ["Адрес должен начинаться с https://"];
  if (url.username !== "" || url.password !== "") return ["В адресе нельзя указывать логин и пароль"];
  if (url.port !== "") return ["Порт в адресе не поддерживается"];
  if (isInternalHostname(url.hostname)) return ["Адрес указывает на внутреннюю сеть"];
  return [];
}

/**
 * Подставить значения в один проход; значения кодируются `encodeURIComponent`. Неразбираемая подстановка —
 * исключение: что делать с ней, решает вызывающий.
 */
export function fillTemplate(template: string, values: Readonly<Record<PostbackMacro, string>>): URL {
  const filled = template.replace(MACRO, (whole, name: string) => (isMacro(name) ? encodeURIComponent(values[name]) : whole));
  return new URL(filled);
}

/** Адрес для лога: запрос и фрагмент заменены на `?***` — в них токены приёмника. */
export function logUrlOf(url: URL): string {
  return `${url.origin}${url.pathname}${url.search === "" ? "" : "?***"}`;
}

/**
 * То же для хранимого шаблона — аудит и вид без права на правку. Работает по строке, а не по разобранному адресу:
 * макросы в пути остаются такими, как их написал человек.
 */
export function logTemplateOf(template: string): string {
  const withoutFragment = template.split("#", 1)[0] ?? "";
  const query = withoutFragment.indexOf("?");
  return query < 0 ? withoutFragment : `${withoutFragment.slice(0, query)}?***`;
}
