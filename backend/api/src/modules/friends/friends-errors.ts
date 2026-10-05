import { DomainError } from "../../common/domain-error.js";

/** Игрока нет, он заблокирован или на другой площадке — для дружбы это одно и то же. */
export class FriendNotFoundError extends DomainError {
  constructor(message = "Игрок не найден") {
    super("friend_not_found", message, 404);
  }
}

export class FriendRequestNotFoundError extends DomainError {
  constructor() {
    super("friend_request_not_found", "Заявки нет — её отменили или уже ответили", 404);
  }
}

/** Потолок друзей или заявок: повтор не поможет, пока кто-то не освободит место. */
export class FriendLimitError extends DomainError {
  constructor(message: string) {
    super("friend_limit", message, 409);
  }
}

/**
 * Приглашение сообщением не подготовить: площадка так не умеет, ссылка ещё
 * не собрана или бот не ответил. Клиент на этот код молча зовёт прежним
 * путём — выбором чата со ссылкой.
 */
export class InviteUnavailableError extends DomainError {
  constructor(message: string) {
    super("invite_unavailable", message, 503);
  }
}
