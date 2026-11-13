import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { WEEK_STEP_MUL, levelMul, parseDailyLadder } from "../daily/daily-rules.js";
import { MAX_LEVEL, maxLevelReward, parseLevelLadder } from "../progress/progress-rules.js";
import { SETTING_LIST, type SettingDefinition, type SettingValue } from "../settings/setting-catalog.js";
import { SettingsService } from "../settings/settings.service.js";
import { WALLET_DAILY_CAPS } from "../wallet/wallet-limits.js";
import type { ChangeKindHandler } from "./change-request-kinds.js";
import { ChangeRequestValueError } from "./change-request-errors.js";
import { sameJson } from "./change-request-rules.js";
import type { ChangeRequestRow, ChangeTargetView, ChangeTx, JsonValue } from "./change-request-types.js";

/**
 * Вид правки «награда» (docs/19-content-admin.md §6, tasks/T-0310): цель —
 * ключ каталога настроек с пометкой «деньги» (`rewards.*`), правка — одно
 * значение, которое после подтверждения ложится в `app_setting`, как ложилось
 * бы из панели настроек. Сервер читает ключ на каждом начислении, поэтому
 * правка действует со следующей награды, а начисленное не пересчитывается.
 *
 * Значение проверяется схемой ключа до заявки; лестницы приводятся к
 * каноническому виду, чтобы «было» сравнивалось строкой, а не пробелами.
 * Потолки кошелька остаются в коде: награда выше них — предупреждение в
 * заявке, а не отказ.
 */

const valueSchema = z.object({ value: z.union([z.number(), z.string()]) }).strict();

/** Ключи «деньги» каталога: их можно править только заявкой. */
const MONEY_SETTINGS: readonly SettingDefinition[] = SETTING_LIST.filter((setting) => setting.money === true);

function moneySetting(target: string): SettingDefinition | undefined {
  return MONEY_SETTINGS.find((setting) => setting.key === target);
}

/** Значение в каноническом виде: у лестниц — без лишних пробелов и в одном порядке знаков. */
function canonicalValue(setting: SettingDefinition, value: SettingValue): SettingValue {
  if (typeof value !== "string") return value;
  if (setting.key === "rewards.level-ladder") {
    const parsed = parseLevelLadder(value);
    return parsed.ok ? parsed.text : value;
  }
  if (setting.key === "rewards.daily-ladder") {
    const parsed = parseDailyLadder(value);
    return parsed.ok ? parsed.text : value;
  }
  return value;
}

const GROUPED = new Intl.NumberFormat("ru-RU", { useGrouping: true });
const grouped = (value: number): string => GROUPED.format(value).replace(/ | /g, " ");

/** Цель правки по ключу. Неизвестный — отказ со словами, а не заявка в никуда. */
function requireSetting(target: string): SettingDefinition {
  const setting = moneySetting(target);
  if (setting === undefined) throw new ChangeRequestValueError(`«${target}» не число награды: правятся потолки и порог забега, лестница уровней и неделя награды дня`);
  return setting;
}

/** Значение по схеме ключа; текст отказа — название и причина словами. */
function checked(setting: SettingDefinition, value: unknown): SettingValue {
  const parsed = setting.schema.safeParse(value);
  if (!parsed.success) throw new ChangeRequestValueError(`${setting.title}: ${parsed.error.issues[0]?.message ?? "некорректное значение"}`);
  return canonicalValue(setting, parsed.data);
}

/** «Название: 600 → 800» — одна строка для чата и журнала. */
export function describeRewardChange(setting: Pick<SettingDefinition, "title">, before: JsonValue, after: JsonValue): string {
  const show = (value: JsonValue): string => {
    const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? value.value : undefined;
    if (typeof raw === "number") return grouped(raw);
    return typeof raw === "string" ? `«${raw}»` : "—";
  };
  return `${setting.title}: ${show(before)} → ${show(after)}`;
}

@Injectable()
export class RewardSettingKind implements ChangeKindHandler {
  readonly kind = "reward_setting" as const;
  readonly permission = "sku.price.edit" as const;

  constructor(private readonly settings: Pick<SettingsService, "get" | "refresh" | "reload">) {}

  async prepare(tx: ChangeTx, target: string, input: unknown): Promise<{ before: JsonValue; after: JsonValue }> {
    const setting = requireSetting(target);
    const parsed = valueSchema.safeParse(input);
    if (!parsed.success) throw new ChangeRequestValueError(`${setting.title}: в заявке одно поле «value» — число или строка`);
    const value = checked(setting, parsed.data.value);
    const now = await this.stored(tx, setting);
    if (sameJson(value, now)) throw new ChangeRequestValueError("Ничего не меняется: в заявке то же значение, что сейчас");
    return { before: { value: now }, after: { value } };
  }

  async current(tx: ChangeTx, request: ChangeRequestRow): Promise<JsonValue> {
    const setting = moneySetting(request.target);
    // Ключ ушёл из каталога выкатом: «было» описывало то, чего больше нет, — заявка устарела.
    if (setting === undefined) return null;
    return { value: await this.stored(tx, setting) };
  }

  async apply(tx: ChangeTx, request: ChangeRequestRow, by: string): Promise<void> {
    const setting = requireSetting(request.target);
    const parsed = valueSchema.safeParse(request.after);
    if (!parsed.success) throw new ChangeRequestValueError(`${setting.title}: в заявке одно поле «value» — число или строка`);
    const value = checked(setting, parsed.data.value);
    await tx.appSetting.upsert({
      where: { key: setting.key },
      create: { key: setting.key, value, updatedBy: by },
      update: { value, updatedBy: by },
    });
  }

  /** Число уже в базе: память этой реплики обновляется сразу, соседние — по сообщению. */
  async afterCommit(request: ChangeRequestRow): Promise<void> {
    await this.settings.reload(request.target);
  }

  warnings(request: ChangeRequestRow): string[] {
    const setting = moneySetting(request.target);
    const parsed = valueSchema.safeParse(request.after);
    if (setting === undefined || !parsed.success) return [];
    return capWarnings(setting.key, parsed.data.value).map((text) => `Выше суточного потолка — часть не начислится: ${text}`);
  }

  async targets(): Promise<ChangeTargetView[]> {
    await this.settings.refresh();
    return MONEY_SETTINGS.map((setting) => {
      const current = canonicalValue(setting, this.settings.get(setting));
      const inCode = canonicalValue(setting, setting.fallback);
      return { target: setting.key, title: setting.title, hint: setting.hint, current: { value: current }, inCode: { value: inCode }, overridden: !sameJson(current, inCode) };
    });
  }

  describe(request: ChangeRequestRow): string {
    const setting = moneySetting(request.target);
    return describeRewardChange(setting ?? { title: request.target }, request.before, request.after);
  }

  /** Число в базе; нет строки или она не проходит схему — действует умолчание, как у читателя настройки. */
  private async stored(tx: ChangeTx, setting: SettingDefinition): Promise<SettingValue> {
    const row = await tx.appSetting.findUnique({ where: { key: setting.key } });
    if (row !== null) {
      const parsed = setting.schema.safeParse(row.value);
      if (parsed.success) return canonicalValue(setting, parsed.data);
    }
    return canonicalValue(setting, setting.fallback);
  }
}

/**
 * Где награда по ключу упирается в суточный потолок кошелька. Потолок — защита
 * от ошибки в числах (`wallet/wallet-limits.ts`), он остаётся в коде: заявка с
 * большим числом заводится, но решающий видит, что часть не дойдёт до игрока.
 */
function capWarnings(key: string, value: number | string): string[] {
  const warnings: string[] = [];
  const over = (what: string, amount: number, cap: number): void => {
    if (amount > cap) warnings.push(`${what} до ${grouped(amount)} при потолке ${grouped(cap)} в сутки`);
  };
  if (key === "rewards.run-max-coins" && typeof value === "number") {
    over("монеты за забег", value, WALLET_DAILY_CAPS.run_reward.coins ?? 0);
  }
  if (key === "rewards.level-ladder" && typeof value === "string") {
    const parsed = parseLevelLadder(value);
    if (parsed.ok) {
      const top = maxLevelReward(parsed.ladder);
      over(`монеты за уровень (до ${String(MAX_LEVEL)}-го)`, top.coins, WALLET_DAILY_CAPS.level_reward.coins ?? 0);
      over("самоцветы за уровень", top.gems, WALLET_DAILY_CAPS.level_reward.gems ?? 0);
    }
  }
  if (key === "rewards.daily-ladder" && typeof value === "string") {
    const parsed = parseDailyLadder(value);
    if (parsed.ok) {
      // Самый щедрый день: ступень последней недели и множитель сотого уровня.
      const step = WEEK_STEP_MUL[WEEK_STEP_MUL.length - 1] ?? 1;
      const mul = step * levelMul(MAX_LEVEL);
      over("монеты награды дня на сотом уровне", Math.round(Math.max(...parsed.ladder.map((day) => day.coins), 0) * mul), WALLET_DAILY_CAPS.daily_reward.coins ?? 0);
      over("осколки награды дня", Math.round(Math.max(...parsed.ladder.map((day) => day.shards), 0) * step), WALLET_DAILY_CAPS.daily_reward.shard_common ?? 0);
    }
  }
  return warnings;
}
