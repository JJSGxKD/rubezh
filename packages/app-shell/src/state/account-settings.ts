import { z } from "zod/mini";
import { apiRequest } from "./api-request";
import { BOT_NOTIFY_DEFAULTS, botNotifyKeyOf, useBotNotifications } from "./bot-notifications";
import { useDiagnostics } from "./diagnostics";
import { DEFAULT_GRAPHICS, useGraphics } from "./graphics";
import { HINT_ORDER, useHints, type HintId } from "./hints";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Настройки аккаунта (docs/35-stage4-plan.md Р56, WP29): выбранное на ПК
 * приходит на телефон при следующем входе. Идут за аккаунтом участие в
 * помощи в тестировании, запись забегов, усвоенные подсказки, отображение
 * боя и что дублировать в бота; графика, громкость, вибрация и режим экрана —
 * у устройства.
 *
 * Сами значения по-прежнему живут в своих сторах и на устройстве. Здесь —
 * что из них выбрано на этом устройстве и ещё не дошло до сервера. Сливает
 * сервер, и его ответ — истина: время выбора он ставит по своим часам, по
 * возрасту выбора, поэтому часы телефона, ушедшие вперёд или назад, не
 * решают, чей выбор новее.
 *
 * Значение, сохранённое на устройстве до настроек аккаунта, уходит засевом:
 * оно займёт только пустой ключ. Умолчание засевом не уходит — иначе новое
 * устройство перебило бы им прежний выбор игрока на старом.
 *
 * Ключи и версия — те же, что на сервере
 * (`backend/api/src/modules/account-settings/account-settings.catalog.ts`),
 * расхождение ловит `scripts/test/account-settings-keys.test.ts`.
 */

export const ACCOUNT_SETTINGS_VERSION = 1;

export const ACCOUNT_SETTING_KEYS = [
  "testing.enabled",
  "testing.recordRuns",
  "hints.seen",
  "combat.telegraphs",
  "combat.damageNumbers",
  "bot.friendRequest",
  "bot.friendGift",
  "bot.teamMessage",
] as const;

export type AccountSettingKey = (typeof ACCOUNT_SETTING_KEYS)[number];
export type AccountSettingValue = boolean | string[];

const STAMPS_KEY = "bh.account-settings.v1";
/** Изменения подряд — одним запросом: переключатели щёлкают сериями. */
const PUSH_DELAY_MS = 1_500;

const valueSchema = z.union([z.boolean(), z.array(z.string())]);
/**
 * `pending` — выбрано здесь и не подтверждено сервером; `at` у такой записи —
 * по часам устройства, у подтверждённой — по часам сервера. `seed` —
 * значение, сохранённое до настроек аккаунта.
 */
const entrySchema = z.object({ value: valueSchema, at: z.number(), pending: z.optional(z.boolean()), seed: z.optional(z.boolean()) });
/** `accountId` — чьи это записи: на одном устройстве может войти другой аккаунт. */
const stampsSchema = z.object({ accountId: z.optional(z.string()), values: z.record(z.string(), entrySchema) });
const responseSchema = z.object({ version: z.number(), values: z.record(z.string(), z.object({ value: valueSchema, at: z.number() })) });

type Stamps = z.infer<typeof stampsSchema>;
type RemoteValues = z.infer<typeof responseSchema>["values"];
type Outgoing = { value: AccountSettingValue; ageMs: number } | { value: AccountSettingValue; seed: true };
/** что ушло в запросе — запись с устройства, как она была в момент отправки */
type Sent = Partial<Record<AccountSettingKey, z.infer<typeof entrySchema>>>;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** С каким аккаунтом синхронизировались в этом запуске: до синхронизации отправлять рано. */
let syncedAccount: string | null = null;
let syncing: Promise<void> | null = null;

/**
 * Игрок сам поменял настройку аккаунта — запомнить и отправить. Без входа
 * отправлять некуда: выбор полежит на устройстве и уйдёт при синхронизации.
 */
export function noteAccountSetting(key: AccountSettingKey, value: AccountSettingValue, nowMs = Date.now()): void {
  const record = stamps().read();
  record.values[key] = { value, at: nowMs, pending: true };
  stamps().write(record);
  schedulePush();
}

/** Для тестов: забыть отложенную отправку и синхронизацию — иначе они дожили бы до соседнего теста. */
export function resetAccountSettingsForTests(): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = null;
  syncedAccount = null;
  syncing = null;
}

/**
 * Сессия появилась: забрать настройки аккаунта, применить их и отправить
 * выбранное здесь. Вызовы подряд идут друг за другом, а не наперегонки.
 */
export function syncAccountSettings(accountId: string): Promise<void> {
  const run = (syncing ?? Promise.resolve()).then(() => runSync(accountId));
  const tail = run.finally(() => {
    if (syncing === tail) syncing = null;
  });
  syncing = tail;
  return tail;
}

async function runSync(accountId: string): Promise<void> {
  if (useShell.getState().capabilities.auth === undefined) return;
  const response = await apiRequest("/api/v1/account/settings", responseSchema, { method: "GET" });
  if (!response.ok) return;

  let record = stamps().read();
  // Устройство впервые встречает аккаунт: сохранённое до настроек аккаунта —
  // засев. Если же здесь уже входил другой аккаунт, его выбор — не наш: и
  // отметки, и значения сторов остаются ему, а сюда приходит своё с сервера.
  const firstOnDevice = record.accountId === undefined;
  if (!firstOnDevice && record.accountId !== accountId) record = { values: {} };
  record.accountId = accountId;
  if (firstOnDevice) {
    for (const key of ACCOUNT_SETTING_KEYS) {
      if (record.values[key] === undefined && isOwnChoice(key)) record.values[key] = { value: currentValue(key), at: 0, pending: true, seed: true };
    }
  }
  stamps().write(record);
  adopt(response.data.values, {});
  syncedAccount = accountId;

  await send(accountId);
  // Выбранное, пока шла синхронизация, уйдёт следующим запросом.
  if (Object.values(stamps().read().values).some((entry) => entry.pending === true)) schedulePush();
}

function schedulePush(): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    // До синхронизации отправлять рано: она сама возьмёт выбранное здесь.
    if (syncedAccount !== null && syncing === null) void send(syncedAccount);
  }, PUSH_DELAY_MS);
}

/** Отправить неподтверждённое: выбор — возрастом, прежнее значение — засевом. */
async function send(accountId: string): Promise<void> {
  const record = stamps().read();
  if (record.accountId !== accountId) return;
  const nowMs = Date.now();
  const outgoing: Partial<Record<AccountSettingKey, Outgoing>> = {};
  const sent: Sent = {};
  for (const key of ACCOUNT_SETTING_KEYS) {
    const entry = record.values[key];
    if (entry?.pending !== true) continue;
    outgoing[key] = entry.seed === true ? { value: entry.value, seed: true } : { value: entry.value, ageMs: Math.max(0, nowMs - entry.at) };
    sent[key] = entry;
  }
  if (Object.keys(outgoing).length === 0) return;

  // Не ушло — не беда: выбор лежит на устройстве, и следующая синхронизация
  // при входе отправит его сама.
  const response = await apiRequest("/api/v1/account/settings", responseSchema, { method: "POST", body: { version: ACCOUNT_SETTINGS_VERSION, values: outgoing } });
  if (response.ok) adopt(response.data.values, sent);
}

/**
 * Принять слитое сервером. Неподтверждённое остаётся, если его не отправляли
 * или игрок выбрал снова, пока шёл запрос: его отправит следующий. Стор
 * сверяется отдельно: переключатель сообщает о выборе через ленивый импорт,
 * и ответ не должен откатить выбор, который ещё не записан.
 */
function adopt(remote: RemoteValues, sentEntries: Sent): void {
  const record = stamps().read();
  for (const key of ACCOUNT_SETTING_KEYS) {
    const local = record.values[key];
    const sent = sentEntries[key];
    if (local?.pending === true && sent?.at !== local.at) continue;
    if (sent !== undefined && !sameValue(currentValue(key), sent.value)) continue;
    const entry = remote[key];
    if (entry === undefined) {
      // Отправленное сервер не принял — слать его снова на каждом входе незачем.
      if (local !== undefined && sent !== undefined) record.values[key] = { value: local.value, at: local.at };
      continue;
    }
    if (!sameValue(entry.value, currentValue(key))) applyValue(key, entry.value);
    record.values[key] = { value: entry.value, at: entry.at };
  }
  stamps().write(record);
}

/** Что сейчас стоит в сторе. */
function currentValue(key: AccountSettingKey): AccountSettingValue {
  const diagnostics = useDiagnostics.getState();
  const graphics = useGraphics.getState();
  switch (key) {
    case "testing.enabled":
      return diagnostics.enabled;
    case "testing.recordRuns":
      return diagnostics.recordRuns;
    case "hints.seen":
      return [...useHints.getState().seen];
    case "combat.telegraphs":
      return graphics.telegraphs;
    case "combat.damageNumbers":
      return graphics.damageNumbers;
    case "bot.friendRequest":
      return useBotNotifications.getState().friendRequest;
    case "bot.friendGift":
      return useBotNotifications.getState().friendGift;
    case "bot.teamMessage":
      return useBotNotifications.getState().teamMessage;
  }
}

/**
 * Выбрал ли игрок это значение сам: отличается от умолчания. Значение, равное
 * умолчанию, от нетронутого не отличить, и спорить ему не о чем. У
 * диагностики умолчание — сборки: засев не должен закрепить его за аккаунтом.
 */
function isOwnChoice(key: AccountSettingKey): boolean {
  const diagnosticsDefault = useShell.getState().capabilities.diagnosticsByDefault;
  switch (key) {
    case "testing.enabled":
    case "testing.recordRuns":
      return currentValue(key) !== diagnosticsDefault;
    case "hints.seen":
      return useHints.getState().seen.length > 0;
    case "combat.telegraphs":
      return currentValue(key) !== DEFAULT_GRAPHICS.telegraphs;
    case "combat.damageNumbers":
      return currentValue(key) !== DEFAULT_GRAPHICS.damageNumbers;
    case "bot.friendRequest":
      return currentValue(key) !== BOT_NOTIFY_DEFAULTS.friendRequest;
    case "bot.friendGift":
      return currentValue(key) !== BOT_NOTIFY_DEFAULTS.friendGift;
    case "bot.teamMessage":
      return currentValue(key) !== BOT_NOTIFY_DEFAULTS.teamMessage;
  }
}

function sameValue(a: AccountSettingValue, b: AccountSettingValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item) => b.includes(item));
  return a === b;
}

/** Применить пришедшее с сервера — без новой отметки и без события: это не выбор игрока здесь. */
function applyValue(key: AccountSettingKey, value: AccountSettingValue): void {
  if (key === "hints.seen") {
    if (Array.isArray(value)) useHints.getState().applyAccount(value.filter((id): id is HintId => (HINT_ORDER as readonly string[]).includes(id)));
    return;
  }
  if (typeof value !== "boolean") return;
  const botKey = botNotifyKeyOf(key);
  if (botKey !== undefined) useBotNotifications.getState().applyAccount({ [botKey]: value });
  else if (key === "testing.enabled") useDiagnostics.getState().applyAccount({ enabled: value });
  else if (key === "testing.recordRuns") useDiagnostics.getState().applyAccount({ recordRuns: value });
  else if (key === "combat.telegraphs") useGraphics.getState().applyAccount({ telegraphs: value });
  else useGraphics.getState().applyAccount({ damageNumbers: value });
}

function stamps(): ReturnType<typeof createPersistedValue<Stamps>> {
  return createPersistedValue<Stamps>({
    storage: useShell.getState().storage,
    key: STAMPS_KEY,
    schema: stampsSchema,
    fallback: { values: {} },
    onBroken: (key, reason) => reportError("account-settings", `${key}: ${reason}`),
  });
}
