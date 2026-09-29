import { z } from "zod";

/**
 * Какие настройки идут за аккаунтом (docs/35-stage4-plan.md Р56, WP29): то,
 * что игрок выбирает один раз, а не на каждом устройстве. Графика, громкость,
 * вибрация и режим экрана — у устройства: сюда они не попадают.
 *
 * Список ключей и версия живут и в клиенте (`app-shell/src/state/account-settings.ts`):
 * собранный бэкенд пакеты клиента не импортирует. Расхождение ключей, версии и
 * подсказок клиента со схемой `hints.seen` ловит
 * `scripts/test/account-settings-keys.test.ts`.
 */

/** Версия набора ключей. Клиент новее сервера шлёт ключи, которых сервер не знает, — они пропускаются. */
export const ACCOUNT_SETTINGS_VERSION = 1;

export type AccountSettingValue = boolean | string[];

const slug = z.string().regex(/^[a-z][a-z0-9_]*$/).max(32);

/**
 * Как сливается ключ: `latest` — побеждает выбранное позже; `union` — список
 * того, что уже случилось (усвоенная подсказка — факт, а не предпочтение),
 * растёт объединением, и только пустой список — сброс — его заменяет.
 */
type MergeKind = "latest" | "union";

interface AccountSettingSpec {
  schema: z.ZodType<AccountSettingValue>;
  merge: MergeKind;
}

export const ACCOUNT_SETTINGS: Record<string, AccountSettingSpec> = {
  /** участие в помощи в тестировании — режим диагностики */
  "testing.enabled": { schema: z.boolean(), merge: "latest" },
  /** запись забегов для разбора */
  "testing.recordRuns": { schema: z.boolean(), merge: "latest" },
  /** какие подсказки первого забега игрок уже усвоил */
  "hints.seen": { schema: z.array(slug).max(16), merge: "union" },
  /** телеграфы атак врагов */
  "combat.telegraphs": { schema: z.boolean(), merge: "latest" },
  /** цифры урона */
  "combat.damageNumbers": { schema: z.boolean(), merge: "latest" },
};

export const ACCOUNT_SETTING_KEYS = Object.keys(ACCOUNT_SETTINGS);

/**
 * Только собственные ключи каталога: `constructor` или `toString` из тела
 * запроса иначе нашли бы метод прототипа и уронили слияние.
 */
export function settingSpec(key: string): AccountSettingSpec | undefined {
  return Object.hasOwn(ACCOUNT_SETTINGS, key) ? ACCOUNT_SETTINGS[key] : undefined;
}

/**
 * Значение и когда его выбрал игрок — по часам сервера, мс UTC. Псевдоним,
 * а не интерфейс: так запись ложится в JSON-колонку без приведения типов.
 */
export type StampedValue = { value: AccountSettingValue; at: number };

export type AccountSettingValues = Record<string, StampedValue>;

/**
 * Что присылает устройство. Время выбора — не по часам устройства, а
 * возрастом: `ageMs` — сколько прошло с выбора до отправки. Часы телефона
 * бывают и в будущем, и в прошлом; постоянный сдвиг при вычитании пропадает,
 * и время выбора сервер ставит по своим часам. `seed` — значение, сохранённое
 * на устройстве до настроек аккаунта: когда его выбрали, неизвестно.
 */
export type IncomingSetting = { value?: unknown; ageMs?: number; seed?: boolean };

/** Отметка засева: позже пустоты, раньше любого выбора, сделанного при настройках аккаунта. */
export const SEED_AT = 1;

const stampedSchema = z.object({ value: z.unknown(), at: z.number().finite() });

/**
 * Прочитать сохранённое: JSON из базы — граница. Ключ, которого код больше не
 * знает, и значение не по нынешней схеме пропускаются, а не роняют чтение.
 */
export function readStored(raw: unknown): AccountSettingValues {
  const parsed = z.record(z.string(), stampedSchema).safeParse(raw);
  if (!parsed.success) return {};
  const values: AccountSettingValues = {};
  for (const [key, entry] of Object.entries(parsed.data)) {
    const value = settingSpec(key)?.schema.safeParse(entry.value);
    if (value?.success === true) values[key] = { value: value.data, at: entry.at };
  }
  return values;
}

/**
 * Слить присланное с сохранённым, ключ за ключом. Время выбора — часы сервера
 * минус возраст выбора, не раньше отметки засева; засев занимает только
 * пустой ключ. Неизвестный ключ и значение не по схеме пропускаются и
 * называются в ответе: клиент новее сервера — не ошибка.
 */
export function mergeSettings(stored: AccountSettingValues, incoming: Record<string, IncomingSetting>, nowMs: number): { values: AccountSettingValues; ignored: string[] } {
  const values: AccountSettingValues = { ...stored };
  const ignored: string[] = [];
  for (const [key, entry] of Object.entries(incoming)) {
    const spec = settingSpec(key);
    const parsed = spec?.schema.safeParse(entry.value);
    if (spec === undefined || parsed?.success !== true || (entry.seed !== true && entry.ageMs === undefined)) {
      ignored.push(key);
      continue;
    }
    const at = entry.seed === true ? SEED_AT : Math.max(SEED_AT + 1, nowMs - Math.min(Math.max(0, Math.floor(entry.ageMs ?? 0)), nowMs));
    const next = merged(spec.merge, values[key], { value: parsed.data, at });
    if (next !== undefined) values[key] = next;
  }
  return { values, ignored };
}

function merged(kind: MergeKind, current: StampedValue | undefined, incoming: StampedValue): StampedValue | undefined {
  if (current === undefined) return incoming;
  if (kind === "latest" || !Array.isArray(incoming.value) || !Array.isArray(current.value)) return incoming.at > current.at ? incoming : undefined;
  // Пустой список — сброс «показать подсказки заново»: заменяет, если сделан позже.
  if (incoming.value.length === 0) return incoming.at > current.at ? incoming : undefined;
  // Сброс после этого выбора его отменяет; иначе усвоенное складывается, даже
  // если устройство без сети прислало его с опозданием.
  if (current.value.length === 0 && current.at >= incoming.at) return undefined;
  const seen = current.value;
  const union = [...seen, ...incoming.value.filter((id) => !seen.includes(id))].slice(0, 16);
  return { value: union, at: Math.max(current.at, incoming.at) };
}
