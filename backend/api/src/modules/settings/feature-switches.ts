import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { SETTINGS } from "./setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "./settings.service.js";

/**
 * Работает ли функция прямо сейчас (docs/35-stage4-plan.md §3.18, Р53): ключи
 * и окружение говорят, возможна ли она, а настройка — включена ли. Первое
 * меняется только перезапуском, второе — из панели на ходу, поэтому
 * спрашивать надо в момент действия, а не при старте.
 */
@Injectable()
export class FeatureSwitches {
  constructor(
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Приём событий: пишет в Postgres, без базы его нет. */
  eventsIngest(): boolean {
    return this.config.databaseUrl !== "" && this.settings.get(SETTINGS.ingestEvents);
  }

  /** Приём отчётов диагностики — тоже в Postgres. */
  reportsIngest(): boolean {
    return this.config.databaseUrl !== "" && this.settings.get(SETTINGS.ingestReports);
  }

  fxPolling(): boolean {
    return this.settings.get(SETTINGS.fxPolling);
  }

  /** Выгрузка через бота: ключ псевдонимов, база и чтение обновлений — и не выключена. */
  exportBot(): boolean {
    return this.config.export.botPossible && this.settings.get(SETTINGS.exportBot);
  }

  /** Новые счета и подтверждение перед оплатой. Оплаченное засчитывается и без этого. */
  payments(): boolean {
    return this.config.payments.possible && this.settings.get(SETTINGS.paymentsStars);
  }
}
