import { Controller, Get, HttpCode, Inject, Param, Req } from "@nestjs/common";
import { Public } from "../../common/access.js";
import { DisabledError, RateLimitedError, UnauthorizedError, ValidationError } from "../../common/domain-error.js";
import { addressOf } from "../../common/request-address.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { SECRETS } from "../secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../secrets/secrets.service.js";
import { AdTasks, sameSecret } from "./ad-tasks.js";

/**
 * Адрес награды AdsGram (docs/35-stage4-plan.md WP13, часть 6): AdsGram
 * зовёт его, когда игрок выполнил задание сети, и подставляет вместо
 * `[userId]` его id в Telegram. Путь — `ADSGRAM_REWARD_PATH` из каталога
 * ключей: по нему панель собирает адрес для кабинета.
 *
 * Открыт наружу по замыслу: зовёт сеть, а не игрок. Подписи у запроса нет —
 * подделку отличает только секрет в пути, а без открытой сессии задания
 * подтверждение не даёт ничего. Сеть ждёт 200 — его получает и
 * подтверждение, которому нечего выполнить: повторять его бессмысленно.
 *
 * Лимитов два, потому что зовёт сеть, а не игрок. По адресу — до сверки
 * секрета: он держит нагрузку от того, кто секрета не знает, а запас в три
 * тысячи в час покрывает волну наград. По игроку — после сверки: повтор
 * награды одного и того же игрока раз за разом упирается в него, а
 * подтверждение не зовётся.
 */
/** С одного адреса: держит нагрузку до сверки секрета; запас — на волну наград сети. */
const REWARD_IP_LIMIT: RateLimit = { scope: "ads_adsgram_reward_ip", limit: 3000, windowSec: 3600 };
/** На игрока: повтор награды одного игрока упирается сюда. */
const REWARD_USER_LIMIT: RateLimit = { scope: "ads_adsgram_reward_user", limit: 60, windowSec: 3600 };

/** id игрока в Telegram — положительное целое. */
const TELEGRAM_USER_ID = /^[1-9][0-9]{0,19}$/;

@Controller("ads/adsgram")
export class AdsgramRewardController {
  constructor(
    private readonly tasks: AdTasks,
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get("reward/:secret/:userId")
  @HttpCode(200)
  async reward(@Req() request: unknown, @Param("secret") secret: string, @Param("userId") userId: string): Promise<{ data: { rewarded: boolean } }> {
    if (!(await this.limiter.consume(REWARD_IP_LIMIT, addressOf(request)))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    const expected = this.secrets.get(SECRETS.adsgramRewardSecret);
    // Адрес не создан — ручки для внешнего мира нет.
    if (expected === null) throw new DisabledError("Адрес награды AdsGram не создан");
    if (!sameSecret(secret, expected)) throw new UnauthorizedError("Неверный адрес награды");
    if (!TELEGRAM_USER_ID.test(userId)) throw new ValidationError("id игрока — число");
    if (!(await this.limiter.consume(REWARD_USER_LIMIT, userId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    const outcome = await this.tasks.confirm("adsgram", "telegram", userId, new Date());
    return { data: { rewarded: outcome === "confirmed" } };
  }
}
