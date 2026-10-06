import { Injectable, Logger } from "@nestjs/common";
import type { StartParam } from "../attribution/start-param.js";
import type { AccountPlatform } from "./access-token.js";

/**
 * Вход состоялся — кому это интересно: сессиям и атрибуции
 * (docs/34-stage3-plan.md, WP6). Модуль входа о них не знает: слушатели
 * подписываются сами — тот же приём, что `RunsHooks`.
 *
 * **Вход их не ждёт.** Запись сессии в источнике переноса шла в транзакции на
 * горячем пути входа и блокировала строку пользователя
 * (docs/13-reuse-from-vpnsibcom.md §6); здесь слушатели работают после ответа,
 * и упавший не отменяет вход.
 */

/** Что клиент говорит о себе при входе — подсказка, а не факт. */
export interface LoginClient {
  /** `tgWebAppPlatform` */
  platform: string | null;
  /** `tgWebAppVersion` */
  version: string | null;
}

/** Обстоятельства входа, которых нет в подписи: откуда запрос и зачем. */
export interface LoginContext {
  /** адрес из `req.ip` — с учётом доверенных прокси, не из сырого заголовка */
  ip: string | null;
  userAgent: string | null;
  client: LoginClient | null;
  /**
   * `launch` — вход на запуске игры; `reauth` — повторный вход посреди
   * работы, когда сессия потерялась. Сессией считается только запуск.
   */
  reason: "launch" | "reauth";
}

export interface LoginEvent extends LoginContext {
  accountId: string;
  platform: AccountPlatform;
  /**
   * `web` — вход разработчика в браузере; `channel` — вход в канал площадки
   * до приложения: `/start` бота, «Начать» сообщества (docs/35-stage4-plan.md,
   * §3.10). Токенов у такого входа нет — это знакомство, а не сессия.
   */
  place: "miniapp" | "web" | "channel";
  /** параметр запуска из подписанных данных */
  startParam: StartParam;
  /** аккаунт заведён этим входом */
  created: boolean;
  at: Date;
}

export type LoginListener = (login: LoginEvent) => Promise<void>;

/** Вход без подробностей — там, где их неоткуда взять: тесты, командная строка. */
export const PLAIN_LOGIN: LoginContext = { ip: null, userAgent: null, client: null, reason: "launch" };

@Injectable()
export class AuthHooks {
  private readonly logger = new Logger("auth");
  private readonly listeners: { name: string; listener: LoginListener }[] = [];

  onLogin(name: string, listener: LoginListener): void {
    this.listeners.push({ name, listener });
  }

  emit(login: LoginEvent): Promise<void> {
    return Promise.all(
      this.listeners.map(async ({ name, listener }) => {
        try {
          await listener(login);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "auth",
              event: "login_listener_failed",
              listener: name,
              accountId: login.accountId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }
}
