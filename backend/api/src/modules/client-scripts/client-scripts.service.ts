import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";

/**
 * Какие чужие скрипты клиента разрешены (docs/35-stage4-plan.md Р93). Правило
 * одно на все места: аварийный выключатель гасит всё, а частный — только своё.
 * Читается из панели на каждом вызове, поэтому правка видна без перезапуска.
 */
@Injectable()
export class ClientScripts {
  constructor(@Inject(SETTINGS_READER) private readonly settings: SettingsReader) {}

  /** Грузить ли клиенту скрипт Graspil. */
  graspil(): boolean {
    return this.all() && this.settings.get(SETTINGS.clientScriptsGraspil);
  }

  /** Поднимать ли SDK учёта аудитории рекламных сетей на старте. */
  adAudience(): boolean {
    return this.all() && this.settings.get(SETTINGS.clientScriptsAdAudience);
  }

  /** Выдавать ли показы рекламы: их скрипты — тоже чужие. */
  ads(): boolean {
    return this.all();
  }

  private all(): boolean {
    return this.settings.get(SETTINGS.clientScriptsAll);
  }
}
