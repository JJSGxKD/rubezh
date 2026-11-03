import { Inject, Injectable, Logger } from "@nestjs/common";
import { boardKeyOf, pointsFromOf, scoringOfSeason, type Scoring } from "../rating/rating-switch.js";
import { ratingSinceOf } from "../runs/rated-runs.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { dueSeasons, parseStartDate, seasonOf, type Season } from "./season-rules.js";

/**
 * Расписание сезонов (docs/35-stage4-plan.md, Р53: «ключ задан — включено»).
 * Единственное место, которое знает, идут ли сезоны: настройка
 * `seasons.start-date` читается на каждый вызов, и правка из панели
 * действует сразу, без перезапуска и без кеша в сервисах.
 */
@Injectable()
export class SeasonSchedule {
  private readonly logger = new Logger("seasons");

  constructor(@Inject(SETTINGS_READER) private readonly settings: SettingsReader) {}

  /** Понедельник первого сезона; `null` — сезонов нет. */
  startsAt(): Date | null {
    return parseStartDate(this.settings.get(SETTINGS.seasonsStartDate));
  }

  /**
   * Отсечка рейтинга (`rating.since-date`, Р126): сезоны считают забеги не
   * раньше неё. `null` — отсечки нет. Читается на каждый вызов, как и старт.
   */
  ratingSince(): Date | null {
    return ratingSinceOf(this.settings.get(SETTINGS.ratingSinceDate));
  }

  /**
   * Понедельник первого сезона по очкам (`rating.points-from`, T-0294); `null` —
   * сезонов по очкам нет. Читается на каждый вызов.
   */
  pointsFrom(): Date | null {
    return pointsFromOf(this.settings.get(SETTINGS.ratingPointsFrom));
  }

  /** Как ранжирован сезон: до понедельника перехода — по времени, с него — по очкам. */
  scoringOf(season: Season): Scoring {
    return scoringOfSeason(season.startsAt, this.pointsFrom());
  }

  /**
   * Сезон под ключом его доски в Redis: сезон по очкам лежит под `pts:<ключ>`,
   * по времени — под прежним, поэтому переход идёт без окна, где доска пуста.
   * Даты те же — от них считается срок жизни ключа. Ключ сезона в базе итогов и
   * наград остаётся датой понедельника: этот видит только Redis.
   */
  boardSeason(season: Season): Season {
    return { ...season, key: boardKeyOf(season.key, this.scoringOf(season)) };
  }

  /** Порог награды участника в сезоне по очкам (`rating.season-threshold-points`). */
  thresholdPoints(): number {
    return this.settings.get(SETTINGS.ratingSeasonThresholdPoints);
  }

  /** Сезон, в который попадает момент; `null` — сезонов нет или первый ещё не начался. */
  current(at: Date): Season | null {
    const start = this.startsAt();
    return start === null || at.getTime() < start.getTime() ? null : seasonOf(at);
  }

  /**
   * Закончившиеся к `now` сезоны по порядку, не старше потолка догона;
   * закрытые отсеивает вызывающий. Пропущенные потолком — строкой в лог.
   */
  due(now: Date): Season[] {
    const start = this.startsAt();
    if (start === null) return [];
    const { due, skipped } = dueSeasons(start, now);
    if (skipped > 0) this.logger.warn(JSON.stringify({ module: "seasons", event: "season_backfill_capped", skipped }));
    return due;
  }
}
