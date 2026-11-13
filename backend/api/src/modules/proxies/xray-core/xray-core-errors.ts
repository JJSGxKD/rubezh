import { DomainError } from "../../../common/domain-error.js";

/** «Проверить сейчас» чаще раза в минуту на всех. */
export class XrayRefreshTooOftenError extends DomainError {
  constructor() {
    super("xray_refresh_too_often", "Проверять выпуск можно раз в минуту", 429);
  }
}

/** GitHub не принял запуск: ключ, право или файл workflow. */
export class XrayUpdateRefusedError extends DomainError {
  constructor(message: string) {
    super("xray_update_refused", message, 502);
  }
}

/** Ответ GitHub не дошёл или непонятен: запуск мог уйти, поэтому замок остаётся. */
export class XrayUpdateUnknownError extends DomainError {
  constructor(message: string, status: 502 | 504) {
    super(status === 504 ? "xray_update_timeout" : "xray_update_failed", message, status);
  }
}

/** Замок запуска держится: обновление уже запускали. */
export class XrayUpdateLockedError extends DomainError {
  constructor(at: Date | null) {
    const when = at === null ? "только что" : `в ${at.toISOString().slice(11, 16)} по UTC`;
    super("xray_locked", `Обновление уже запускали ${when} — повторить можно через 10 минут`, 409);
  }
}

/** Без Redis замка нет, а без замка не запускаем. */
export class XrayUpdateUnavailableError extends DomainError {
  constructor() {
    super("xray_lock_unavailable", "Не удалось взять замок запуска — повторите позже", 503);
  }
}

/** Выпуск, показанный в панели, уже не тот, что в кэше сервера: версию к запуску берёт сервер. */
export class XrayReleaseChangedError extends DomainError {
  constructor() {
    super("xray_release_changed", "Выпуск сменился — обновите страницу", 409);
  }
}

/** Причины, по которым кнопка «Обновить» закрыта и сервер откажет так же. Замок (`locked`) решает сам. */
export type RefusingBlock = "no_token" | "no_release" | "blocked" | "older" | "up_to_date" | "in_code" | "running";

const BLOCK_MESSAGES: Record<Exclude<RefusingBlock, "blocked">, string> = {
  no_token: "Нет ключа github.xray-update — задайте его в «Ключах интеграций»",
  no_release: "Свежий выпуск не получен — проверьте позже",
  older: "Выпуск старше проверенных версий",
  up_to_date: "Ядро уже этой версии",
  in_code: "Версия уже в коде — уедет с ближайшим выпуском",
  running: "Обновление уже идёт — дождитесь конца запуска",
};

export class XrayUpdateBlockedError extends DomainError {
  constructor(block: RefusingBlock, reason: string | null = null) {
    super(`xray_${block}`, block === "blocked" ? `Перейти нельзя, нужно обновить код: ${reason ?? "причина не записана"}` : BLOCK_MESSAGES[block], 409);
  }
}
