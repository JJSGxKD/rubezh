import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { SettingValue } from "./setting-catalog.js";

/** Настройки в базе (`app_setting`). Их единицы — читаются целиком. */

export interface StoredSetting {
  key: string;
  /** JSON из базы как есть — разбирает сервис схемой ключа */
  value: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

export const SETTINGS_REPOSITORY = Symbol("SETTINGS_REPOSITORY");

export interface SettingsRepository {
  all(): Promise<StoredSetting[]>;
  save(key: string, value: SettingValue, updatedBy: string): Promise<StoredSetting>;
  /** Удалённая строка; `null` — её и не было. */
  remove(key: string): Promise<StoredSetting | null>;
}

@Injectable()
export class PrismaSettingsRepository implements SettingsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async all(): Promise<StoredSetting[]> {
    return await this.prisma.appSetting.findMany({ orderBy: { key: "asc" } });
  }

  async save(key: string, value: SettingValue, updatedBy: string): Promise<StoredSetting> {
    return await this.prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedBy }, update: { value, updatedBy } });
  }

  async remove(key: string): Promise<StoredSetting | null> {
    const before = await this.prisma.appSetting.findUnique({ where: { key } });
    if (before === null) return null;
    const { count } = await this.prisma.appSetting.deleteMany({ where: { key } });
    return count > 0 ? before : null;
  }
}
