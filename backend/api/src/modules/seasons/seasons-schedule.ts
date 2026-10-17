import { Inject, Injectable } from "@nestjs/common";
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
  constructor(@Inject(SETTINGS_READER) private readonly settings: SettingsReader) {}

  /** Понедельник первого сезона; `null` — сезонов нет. */
  startsAt(): Date | null {
    return parseStartDate(this.settings.get(SETTINGS.seasonsStartDate));
  }

  /** Сезон, в который попадает момент; `null` — сезонов нет или первый ещё не начался. */
  current(at: Date): Season | null {
    const start = this.startsAt();
    return start === null || at.getTime() < start.getTime() ? null : seasonOf(at);
  }

  /** Закончившиеся к `now` сезоны с первого, по порядку; закрытые отсеивает вызывающий. */
  due(now: Date): Season[] {
    const start = this.startsAt();
    return start === null ? [] : dueSeasons(start, now);
  }
}
