import { DomainError } from "../../common/domain-error.js";

/** Прокси с таким id нет — 404, а не пустая карточка. */
export class ProxyNotFoundError extends DomainError {
  constructor() {
    super("proxy_not_found", "Прокси не найден", 404);
  }
}

/** Сервиса с таким именем нет в каталоге клиента исходящих — режим задают только известным. */
export class OutboundServiceNotFoundError extends DomainError {
  constructor() {
    super("outbound_service_not_found", "Такого сервиса нет в каталоге исходящих запросов", 404);
  }
}

/** Прокси уже слишком много. */
export class ProxyLimitError extends DomainError {
  constructor(limit: number) {
    super("proxy_limit", `Прокси уже ${String(limit)} — лишние нужно выключить или переделать в нужные`, 409);
  }
}

/** Подписки Xray нет — 404, а не пустая карточка. */
export class SubscriptionNotFoundError extends DomainError {
  constructor() {
    super("proxy_subscription_not_found", "Подписка Xray не подключена", 404);
  }
}

/** Адрес подписки хранится шифртекстом, а ключа шифрования нет — как с паролем прокси (Р53, Р84). */
export class SubscriptionStorageDisabledError extends DomainError {
  constructor() {
    super("secrets_disabled", "Адрес подписки хранится зашифрованным, а в окружении сервера нет SECRETS_ENCRYPTION_KEY (его даёт openssl rand -base64 32)", 409);
  }
}

/** Обновление подписки уже идёт (на этой или другой реплике). */
export class SubscriptionBusyError extends DomainError {
  constructor() {
    super("proxy_subscription_busy", "Обновление уже идёт на сервере; итог появится в разделе через минуту", 409);
  }
}

/** Пароль прокси хранится шифртекстом, а ключа шифрования нет — как с ключами интеграций (Р53). */
export class ProxyPasswordStorageDisabledError extends DomainError {
  constructor() {
    super("secrets_disabled", "Пароль прокси хранится зашифрованным, а в окружении сервера нет SECRETS_ENCRYPTION_KEY (его даёт openssl rand -base64 32)", 409);
  }
}
