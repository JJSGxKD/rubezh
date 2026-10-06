import { Inject, Injectable } from "@nestjs/common";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { TADDY_API, primaryLanguage } from "./ad-creatives.js";
import { AD_NETWORK_PROFILES, keysProblem, missingKeys } from "./ad-networks.js";
import { AdNetworkKeys } from "./ad-network-keys.js";
import type { TaddyApi } from "./taddy-api.js";

/**
 * Учёт аудитории рекламными сетями (docs/35-stage4-plan.md WP12, часть 9,
 * Р78). Сколько рекламы сеть даст, зависит от того, сколько игроков она
 * видит, — а видит она тех, у кого поднят её SDK, и тех, кто запускал бота.
 * Поэтому SDK такой сети поднимается у каждого игрока её площадок, пока у
 * сети заданы ключи, — включена она или нет; выключить учёт — стереть ключ.
 */

/** Сеть, чей SDK клиент поднимает при запуске, и публичные ключи для него. */
export interface AdNetworkSetup {
  network: string;
  keys: Readonly<Record<string, string>>;
}

/** Кто запустил бота — Telegram ID, язык и премиум из обновления бота. */
export interface BotStarter {
  id: number;
  language: string | null;
  premium: boolean | null;
}

@Injectable()
export class AdAudience {
  constructor(
    private readonly keys: AdNetworkKeys,
    @Inject(TADDY_API) private readonly taddy: TaddyApi,
  ) {}

  /** Сети для SDK на старте: учитывают аудиторию, работают на площадке игрока и имеют все ключи нужного вида. */
  async launchSetup(platform: PlatformId): Promise<AdNetworkSetup[]> {
    const all = await this.keys.all();
    return AD_NETWORK_PROFILES.filter((profile) => profile.trackAudience === true && profile.platforms.includes(platform)).flatMap((profile) => {
      const keys = all.get(profile.key);
      if (keys === undefined || missingKeys(profile, keys).length > 0 || keysProblem(profile, keys) !== null) return [];
      return [{ network: profile.key, keys: { ...keys } }];
    });
  }

  /**
   * Игрок запустил бота — Taddy так учитывает аудиторию бота (`events/start`,
   * как в `vpnsibcom_api`). Ответ игроку этого не ждёт: зовущий не ждёт
   * промиса, а у вызова сети свой таймаут.
   */
  async botStarted(starter: BotStarter, startParam: string | null): Promise<void> {
    const pubId = (await this.keys.of("taddy"))?.["pubId"] ?? "";
    if (pubId === "") return;
    const language = primaryLanguage(starter.language);
    await this.taddy.start(
      pubId,
      {
        id: starter.id,
        ...(language === null ? {} : { language }),
        ...(starter.premium === null ? {} : { premium: starter.premium }),
      },
      startParam !== null && /^[A-Za-z0-9_-]{1,64}$/.test(startParam) ? startParam : null,
    );
  }
}
