import { Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { settingByKey, type SettingDefinition, type SettingKind, type SettingRange, type SettingValue } from "../settings/setting-catalog.js";
import { SettingsService, type SettingSource, type SettingState } from "../settings/settings.service.js";
import { SettingNotFoundError } from "./admin-errors.js";

/**
 * Настройки в панели (docs/29-admin-panel.md §2, «Флаги и выкат»; Р53):
 * право `settings.edit`, каждое изменение — в аудит. Значение разбирается
 * схемой ключа из каталога: панель не знает о настройке ничего, чего не
 * знает код.
 */

export interface SettingView {
  key: string;
  group: string;
  title: string;
  hint: string;
  kind: SettingKind;
  /** пределы и единица числа — редактор панели проверяет то же, что сервер; у остальных видов `null` */
  range: SettingRange | null;
  value: SettingValue;
  source: SettingSource;
  /** что лежит в окружении — вернётся после сброса; `null` — там не задано */
  envValue: SettingValue | null;
  fallback: SettingValue;
  updatedBy: string | null;
  updatedAt: Date | null;
}

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly roles: RolesService,
  ) {}

  async list(actor: AccountRef): Promise<SettingView[]> {
    await this.roles.require(actor, "settings.edit");
    return this.settings.describe().map(viewOf);
  }

  async save(actor: AccountRef, key: string, raw: unknown): Promise<SettingView> {
    await this.roles.require(actor, "settings.edit");
    const setting = this.definition(key);
    const parsed = setting.schema.safeParse(raw);
    if (!parsed.success) throw new ValidationError(`${setting.title}: ${parsed.error.issues[0]?.message ?? "некорректное значение"}`);
    const before = this.state(setting);
    await this.settings.write(setting, parsed.data, actor.accountId);
    const after = this.state(setting);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "settings.save", target: key, before: auditOf(before), after: auditOf(after) });
    return viewOf(after);
  }

  /** Сброс к окружению: строка из базы удаляется, и снова работает `.env` сервера. */
  async reset(actor: AccountRef, key: string): Promise<SettingView> {
    await this.roles.require(actor, "settings.edit");
    const setting = this.definition(key);
    const before = this.state(setting);
    const removed = await this.settings.clear(setting);
    const after = this.state(setting);
    if (removed) await this.roles.audit({ actorAccountId: actor.accountId, action: "settings.reset", target: key, before: auditOf(before), after: auditOf(after) });
    return viewOf(after);
  }

  private definition(key: string): SettingDefinition {
    const setting = settingByKey(key);
    if (setting === undefined) throw new SettingNotFoundError();
    return setting;
  }

  private state(setting: SettingDefinition): SettingState {
    const state = this.settings.describe().find((item) => item.setting.key === setting.key);
    if (state === undefined) throw new SettingNotFoundError();
    return state;
  }
}

function viewOf(state: SettingState): SettingView {
  const { setting } = state;
  return {
    key: setting.key,
    group: setting.group,
    title: setting.title,
    hint: setting.hint,
    kind: setting.kind,
    range: setting.range ?? null,
    value: state.value,
    source: state.source,
    envValue: state.envValue,
    fallback: setting.fallback,
    updatedBy: state.updatedBy,
    updatedAt: state.updatedAt,
  };
}

/** В журнал — действующее значение и откуда оно: «было из окружения, стало из панели». */
function auditOf(state: SettingState): Record<string, unknown> {
  return { value: state.value, source: state.source };
}
