import { Controller, Get, HttpCode, Inject, Param } from "@nestjs/common";
import { Public } from "../../common/access.js";
import { DisabledError, UnauthorizedError, ValidationError } from "../../common/domain-error.js";
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
 */

/** id игрока в Telegram — положительное целое. */
const TELEGRAM_USER_ID = /^[1-9][0-9]{0,19}$/;

@Controller("ads/adsgram")
export class AdsgramRewardController {
  constructor(
    private readonly tasks: AdTasks,
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
  ) {}

  @Public()
  @Get("reward/:secret/:userId")
  @HttpCode(200)
  async reward(@Param("secret") secret: string, @Param("userId") userId: string): Promise<{ data: { rewarded: boolean } }> {
    const expected = this.secrets.get(SECRETS.adsgramRewardSecret);
    // Адрес не создан — ручки для внешнего мира нет.
    if (expected === null) throw new DisabledError("Адрес награды AdsGram не создан");
    if (!sameSecret(secret, expected)) throw new UnauthorizedError("Неверный адрес награды");
    if (!TELEGRAM_USER_ID.test(userId)) throw new ValidationError("id игрока — число");
    const outcome = await this.tasks.confirm("adsgram", "telegram", userId, new Date());
    return { data: { rewarded: outcome === "confirmed" } };
  }
}
