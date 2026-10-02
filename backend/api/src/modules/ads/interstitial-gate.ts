import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import type { FlagsService } from "../flags/flags.service.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { PLACE_FORMAT } from "./ad-networks.js";
import { AD_PLACES, SESSION_TTL_MIN } from "./ads-rules.js";
import { ADS_REPOSITORY, type AdsRepository } from "./ads.repository.js";
import {
  COUNTED_RUN_SEC,
  INTERSTITIAL_FLAG,
  INTERSTITIAL_MOMENTS_OF,
  interstitialNumbers,
  interstitialRule,
  type InterstitialMoment,
  type InterstitialRule,
} from "./interstitial-policy.js";

/**
 * Решение о межстраничной при выдаче показа (docs/35-stage4-plan.md WP12,
 * часть 10): момент — по площадке, игрок — в доле флага, частота — по
 * политике. Клиент только спрашивает: сам он не знает ни покупок, ни
 * роликов за награду на других экранах.
 */

/** Флаги — то, что от них нужно здесь; в тестах — заглушка. */
export type FlagReader = Pick<FlagsService, "isOn">;
export const INTERSTITIAL_FLAGS = Symbol("INTERSTITIAL_FLAGS");

/**
 * Почему межстраничной нет: правило политики, `moment` — площадка в этот
 * момент её не показывает, `flag` — игрок не в доле выката, `no_account` —
 * аккаунта уже нет.
 */
export type InterstitialRefusal = InterstitialRule | "moment" | "flag" | "no_account";

/** Ролики за награду — места, где игрок сам выбрал смотреть видео. Задание сети — не ролик. */
export const REWARDED_VIDEO_PLACES = AD_PLACES.filter((place) => PLACE_FORMAT[place] === "rewarded");

const DB_TIMEOUT_MS = 3_000;
const MINUTE_MS = 60_000;
/** Ролик показывают в пределах срока сессии от выдачи — с этим запасом ищем его по времени выдачи. */
const REWARDED_SHOW_WINDOW_MIN = Math.max(SESSION_TTL_MIN.view, SESSION_TTL_MIN.click);

@Injectable()
export class InterstitialGate {
  constructor(
    @Inject(ADS_REPOSITORY) private readonly repository: AdsRepository,
    @Inject(INTERSTITIAL_FLAGS) private readonly flags: FlagReader,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  /**
   * Ждать ли игроку межстраничную вообще: площадка её показывает, и игрок в
   * доле выката. Клиент узнаёт это на запуске и вне доли старт забега не
   * задерживает даже запросом — контрольная доля живёт как раньше. Частоту
   * всё равно проверяет выдача, и выключенный флаг гасит показы сразу.
   */
  async expected(viewer: { accountId: string; platform: PlatformId }, at: Date): Promise<boolean> {
    if (!INTERSTITIAL_MOMENTS_OF[viewer.platform].includes("run_start")) return false;
    return await withTimeout(this.flags.isOn(INTERSTITIAL_FLAG, viewer, at.getTime()), DB_TIMEOUT_MS, "флаг межстраничной");
  }

  /** `null` — показывать можно. Дешёвые проверки — первыми: до базы доходит только доля флага. */
  async refusal(viewer: { accountId: string; platform: PlatformId }, moment: InterstitialMoment, at: Date): Promise<InterstitialRefusal | null> {
    if (!INTERSTITIAL_MOMENTS_OF[viewer.platform].includes(moment)) return "moment";
    const inRollout = await withTimeout(this.flags.isOn(INTERSTITIAL_FLAG, viewer, at.getTime()), DB_TIMEOUT_MS, "флаг межстраничной");
    if (!inRollout) return "flag";
    const numbers = interstitialNumbers(this.settings);
    const facts = await withTimeout(
      this.repository.interstitialFacts(viewer.accountId, at, {
        countedRunSec: COUNTED_RUN_SEC,
        newbieRuns: numbers.newbieRuns,
        everyRuns: numbers.everyRuns,
        rewardedPlaces: REWARDED_VIDEO_PLACES,
        rewardedSince: new Date(at.getTime() - (numbers.afterRewardMin + REWARDED_SHOW_WINDOW_MIN) * MINUTE_MS),
      }),
      DB_TIMEOUT_MS,
      "факты межстраничной",
    );
    return facts === null ? "no_account" : interstitialRule(numbers, facts, at);
  }
}
