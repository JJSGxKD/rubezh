import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/access-token.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { gameDayKey } from "./game-day-key.js";
import type { OnlineActivity } from "./online-activity.js";
import { ONLINE_REPOSITORY, type OnlineCounts, type OnlinePeak, type OnlineRepository, type PlatformCounts } from "./online.repository.js";

/**
 * Счётчик онлайна (Р107, docs/35-stage4-plan.md): игрок видит, сколько людей
 * в игре и в забеге, панель — то же по площадкам.
 *
 * Пороги показа применяет сервер: ниже порога поле ответа — `null`, и клиент
 * ничего не решает. Порог меняется в панели без релиза.
 */

export interface PingResult {
  /** всего по площадкам; `null` — ниже `online.min-shown` */
  online: number | null;
  /** `null` — ниже `online.run-min-shown` */
  inRun: number | null;
  /** только когда `online === null` */
  todayPlayed: number | null;
  nextPingSec: number;
}

export interface OnlineSnapshot {
  byPlatform: Record<PlatformId, PlatformCounts>;
  total: PlatformCounts;
  peak: OnlinePeak | null;
  /** момент последнего пересчёта, мс; 0 — пересчёта ещё не было */
  at: number;
}

/** Не чаще одной строки в лог в минуту: сбой Redis под нагрузкой иначе утопил бы журнал. */
const WARN_INTERVAL_MS = 60_000;

const ZERO: PlatformCounts = { app: 0, run: 0, today: 0 };

@Injectable()
export class OnlineService implements OnlineActivity {
  private readonly logger = new Logger("online");
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(ONLINE_REPOSITORY) private readonly repository: OnlineRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  touch(claims: AccessTokenClaims, now: Date): void {
    this.repository.touch(claims.accountId, claims.platform, now.getTime(), gameDayKey(now)).catch((error: unknown) => this.warn("touch_failed", error, now));
  }

  async ping(claims: AccessTokenClaims, inRun: boolean, now: Date): Promise<PingResult> {
    const nextPingSec = this.nextPingSec();
    try {
      await this.repository.setInRun(claims.accountId, claims.platform, inRun, now.getTime());
      const counts = await this.repository.counts();
      if (counts === null) return { online: null, inRun: null, todayPlayed: null, nextPingSec };
      const online = counts.total.app >= this.settings.get(SETTINGS.onlineMinShown) ? counts.total.app : null;
      return {
        online,
        inRun: counts.total.run >= this.settings.get(SETTINGS.onlineRunMinShown) ? counts.total.run : null,
        todayPlayed: online === null ? counts.total.today : null,
        nextPingSec,
      };
    } catch (error: unknown) {
      // Пинг — витрина: недоступный Redis оставляет игрока без чисел, но не без ответа.
      this.warn("ping_failed", error, now);
      return { online: null, inRun: null, todayPlayed: null, nextPingSec };
    }
  }

  async adminSnapshot(): Promise<OnlineSnapshot> {
    const [counts, peak] = await Promise.all([this.repository.counts(), this.repository.peak()]);
    if (counts === null) {
      const byPlatform = Object.fromEntries(PLATFORM_IDS.map((platform) => [platform, { ...ZERO }])) as Record<PlatformId, PlatformCounts>;
      return { byPlatform, total: { ...ZERO }, peak, at: 0 };
    }
    return { byPlatform: counts.byPlatform, total: counts.total, peak, at: counts.at };
  }

  /** Пересчёт для задания: числа, затем рекорд. */
  async recount(now: Date): Promise<OnlineCounts> {
    const windowMs = this.settings.get(SETTINGS.onlineWindowSec) * 1_000;
    const counts = await this.repository.recount(now.getTime(), windowMs, gameDayKey(now));
    const peak = await this.repository.peak();
    if (counts.total.app > (peak?.value ?? 0)) await this.repository.setPeak(counts.total.app, now.getTime());
    return counts;
  }

  /** Не больше половины окна: иначе между двумя пингами игрок успел бы выпасть из онлайна. */
  private nextPingSec(): number {
    return Math.min(this.settings.get(SETTINGS.onlinePingSec), Math.floor(this.settings.get(SETTINGS.onlineWindowSec) / 2));
  }

  private warn(event: string, error: unknown, now: Date): void {
    if (now.getTime() - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now.getTime();
    this.logger.warn(JSON.stringify({ module: "online", event, reason: error instanceof Error ? error.message : "unknown" }));
  }
}
