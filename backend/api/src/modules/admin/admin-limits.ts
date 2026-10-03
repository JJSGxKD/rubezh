import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты частоты панели (docs/29-admin-panel.md §8): вход — по адресу, чтобы
 * подбор не упирался только в скорость сети; изменяющие действия и выгрузки —
 * по аккаунту администратора.
 */
export const ADMIN_LIMITS = {
  login: { scope: "admin:login", limit: 10, windowSec: 60 },
  /** опрос входа через бота — раз в две секунды пять минут, с запасом на две вкладки */
  loginPoll: { scope: "admin:login-poll", limit: 90, windowSec: 60 },
  mutate: { scope: "admin:mutate", limit: 60, windowSec: 60 },
  /** проверка ключа зовёт внешний сервис и тратит его лимит — десяток в минуту хватит с запасом */
  secretCheck: { scope: "admin:secret-check", limit: 10, windowSec: 60 },
  /** сборка архива читает всю базу выгрузки — не чаще нескольких раз за десять минут */
  export: { scope: "admin:export", limit: 3, windowSec: 600 },
  /** тест рассылки себе — сообщение живому человеку, пусть и себе: десяток за десять минут */
  broadcastTest: { scope: "admin:broadcast-test", limit: 10, windowSec: 600 },
  /** картинка ложится в базу навсегда: обрезали, передумали, загрузили снова — три десятка за десять минут хватит */
  imageUpload: { scope: "admin:image-upload", limit: 30, windowSec: 600 },
} satisfies Record<string, RateLimit>;
