import { DomainError } from "../../common/domain-error.js";

/**
 * Сессии показа нет, она чужая, истекла или этот шаг для неё уже невозможен:
 * досмотр после отказа, досмотр там, где успех — клик. Клиент отчёт не
 * повторяет — шаг воронки просто не записался.
 */
export class AdSessionClosedError extends DomainError {
  constructor() {
    super("ad_session_closed", "Показ рекламы уже завершён", 409);
  }
}

/** Условие успеха не выполнено или окно забора прошло — награды за этот показ нет. */
export class AdNotCompletedError extends DomainError {
  constructor() {
    super("ad_not_completed", "Реклама не досмотрена — награды нет", 409);
  }
}

/** Награда в этом месте уже была недавно — следующая после паузы. */
export class AdCooldownError extends DomainError {
  constructor(readonly retryAt: Date) {
    super("ad_cooldown", "Награда за рекламу здесь уже была — загляните позже", 409);
  }
}

/** Сети или блока с таким идентификатором нет — панель перечитывает каталог. */
export class AdCatalogNotFoundError extends DomainError {
  constructor(what: "network" | "block") {
    super(what === "network" ? "ad_network_not_found" : "ad_block_not_found", what === "network" ? "Такой рекламной сети нет" : "Такого рекламного блока нет", 404);
  }
}

/**
 * Сеть и место у заведённого блока не меняются: по ним посчитана воронка
 * прошлых показов. Нужен другой — заводится новый блок, а этот выключается.
 */
export class AdBlockShapeLockedError extends DomainError {
  constructor() {
    super("ad_block_shape_locked", "Сеть и место блока не меняются — заведите новый блок, а этот выключите", 409);
  }
}

/** Ключ сети не похож на значение из кабинета или такого ключа у сети нет. */
export class AdNetworkKeysError extends DomainError {
  constructor(message: string) {
    super("ad_network_keys", message, 400);
  }
}

/** Сеть без обязательных ключей не включается: SDK без них ничего не покажет. */
export class AdNetworkIncompleteError extends DomainError {
  constructor(message: string) {
    super("ad_network_incomplete", message, 409);
  }
}

/** Блок не по профилю сети: место не её формата, идентификатор не того вида, не то условие успеха. */
export class AdBlockInvalidError extends DomainError {
  constructor(message: string) {
    super("ad_block_invalid", message, 400);
  }
}

/** Кабинет сети держит ограниченное число блоков формата — лишний включённый не заработает. */
export class AdBlockLimitError extends DomainError {
  constructor(message: string) {
    super("ad_block_limit", message, 409);
  }
}
