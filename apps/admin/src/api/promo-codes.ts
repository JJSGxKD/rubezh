import { z } from "zod";
import { formatNumber, plural } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Промокоды (`/admin/promo-codes`, docs/35-stage4-plan.md WP41): общий код
 * на всех или пачка одноразовых, награда, срок, лимит и кому — под
 * `promo.edit`. Пределы приходят с сервера (`PROMO_CODE_LIMITS`), форма
 * проверяет по ним то, что видно без базы; занят ли код и как его найдёт
 * игрок, мастер спрашивает у сервера, пока код набирают.
 */

export const REWARD_RESOURCES = ["coins", "gems", "shard_common", "shard_uncommon"] as const;
export type RewardResource = (typeof REWARD_RESOURCES)[number];
export type Reward = Record<RewardResource, number>;

export const PLATFORM_TITLES: Partial<Record<string, string>> = { telegram: "Telegram", max: "MAX", vk: "VK", web: "Браузер" };

export const STATE_TITLES: Record<string, string> = {
  active: "действует",
  scheduled: "запланирован",
  paused: "на паузе",
  expired: "срок вышел",
  exhausted: "исчерпан",
};
export const STATE_TONES: Partial<Record<string, "success" | "info" | "warning" | "neutral">> = { active: "success", scheduled: "info", paused: "warning" };

/** Фильтры списка: завершённые — и по сроку, и по лимиту, разница видна в колонке состояния. */
export const FILTERS = [
  { id: "active", title: "Действуют", states: ["active"] },
  { id: "scheduled", title: "Запланированы", states: ["scheduled"] },
  { id: "paused", title: "На паузе", states: ["paused"] },
  { id: "finished", title: "Завершены", states: ["expired", "exhausted"] },
  { id: "all", title: "Все", states: null },
] as const;
export type FilterId = (typeof FILTERS)[number]["id"];

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shard_common: z.number(), shard_uncommon: z.number() });

const campaignSchema = z.object({
  campaignId: z.string(),
  title: z.string(),
  kind: z.enum(["shared", "batch"]),
  reward: rewardSchema,
  message: z.string().nullable(),
  maxRedemptions: z.number().nullable(),
  redeemed: z.number(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  newPlayersDays: z.number().nullable(),
  platforms: z.array(z.string()),
  pausedAt: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  codeSample: z.string(),
  /** чей код; `null` — подарок команды */
  partnerId: z.string().nullable(),
  partnerName: z.string().nullable(),
  state: z.string(),
  remaining: z.number().nullable(),
});
export type PromoCampaign = z.infer<typeof campaignSchema>;

const limitsSchema = z.object({
  reward: rewardSchema,
  codeMinLength: z.number(),
  codeMaxLength: z.number(),
  prefixMaxLength: z.number(),
  batchMax: z.number(),
  maxRedemptions: z.number(),
  newPlayersMaxDays: z.number(),
  aheadDays: z.number(),
  minHours: z.number(),
  titleMax: z.number(),
  noteMax: z.number(),
  messageMax: z.number(),
});
export type PromoCodeLimits = z.infer<typeof limitsSchema>;

const catalogSchema = z.object({
  campaigns: z.array(campaignSchema),
  limits: limitsSchema,
  platforms: z.array(z.string()),
  /** партнёры для шага «Чей код» */
  partners: z.array(z.object({ partnerId: z.string(), name: z.string() })),
  partnerRules: z.object({ bindWindowDays: z.number() }),
});
export type PromoCodeCatalog = z.infer<typeof catalogSchema>;

const detailSchema = z.object({
  campaign: campaignSchema,
  codes: z.array(z.object({ display: z.string(), redeemedAt: z.string().nullable() })),
  daily: z.array(z.object({ day: z.string(), count: z.number() })),
});
export type PromoCampaignDetail = z.infer<typeof detailSchema>;

const checkSchema = z.object({
  display: z.string(),
  key: z.string(),
  problem: z.string().nullable(),
  taken: z.object({ display: z.string(), title: z.string() }).nullable(),
});
export type CodeCheck = z.infer<typeof checkSchema>;

export function fetchPromoCodes(api: AdminApi): Promise<ApiResult<PromoCodeCatalog>> {
  return api.request("/promo-codes", { schema: catalogSchema });
}

export function fetchPromoCode(api: AdminApi, campaignId: string): Promise<ApiResult<PromoCampaignDetail>> {
  return api.request(`/promo-codes/${encodeURIComponent(campaignId)}`, { schema: detailSchema });
}

export function checkCode(api: AdminApi, code: string): Promise<ApiResult<CodeCheck>> {
  return api.request("/promo-codes/check", { query: { code }, schema: checkSchema });
}

export function createPromoCode(api: AdminApi, body: CreateBody): Promise<ApiResult<PromoCampaign>> {
  return api.request("/promo-codes", { method: "POST", body, schema: campaignSchema });
}

export function updatePromoCode(api: AdminApi, campaignId: string, body: UpdateBody): Promise<ApiResult<PromoCampaign>> {
  return api.request(`/promo-codes/${encodeURIComponent(campaignId)}`, { method: "POST", body, schema: campaignSchema });
}

export function setPaused(api: AdminApi, campaignId: string, paused: boolean): Promise<ApiResult<PromoCampaign>> {
  return api.request(`/promo-codes/${encodeURIComponent(campaignId)}/${paused ? "pause" : "resume"}`, { method: "POST", schema: campaignSchema });
}

export function removePromoCode(api: AdminApi, campaignId: string): Promise<ApiResult<{ removed: true }>> {
  return api.request(`/promo-codes/${encodeURIComponent(campaignId)}/remove`, { method: "POST", schema: z.object({ removed: z.literal(true) }) });
}


const REWARD_FORMS: Record<RewardResource, readonly [string, string, string]> = {
  coins: ["монета", "монеты", "монет"],
  gems: ["самоцвет", "самоцвета", "самоцветов"],
  shard_common: ["обычный осколок", "обычных осколка", "обычных осколков"],
  shard_uncommon: ["необычный осколок", "необычных осколка", "необычных осколков"],
};

export const REWARD_TITLES: Record<RewardResource, string> = {
  coins: "Монеты",
  gems: "Самоцветы",
  shard_common: "Осколки: обычные",
  shard_uncommon: "Осколки: необычные",
};

/** Награда строкой: «1 000 монет · 20 самоцветов»; пустая — «ничего». */
export function rewardText(reward: Reward): string {
  const parts = REWARD_RESOURCES.filter((resource) => reward[resource] > 0).map((resource) => `${formatNumber(reward[resource])} ${plural(reward[resource], REWARD_FORMS[resource])}`);
  return parts.length === 0 ? "ничего" : parts.join(" · ");
}

/** Код пачки в списке: приставка и маска вместо случайной части — «ZIMA-····-····». */
export function batchMask(sample: string): string {
  const match = /^(.*?)-?[A-Z0-9]{4}-[A-Z0-9]{4}$/.exec(sample);
  const prefix = match?.[1] ?? "";
  return prefix === "" ? "····-····" : `${prefix}-····-····`;
}

/** Кому: «все» или «новички до 7 дней · Telegram, VK». */
export function audienceText(campaign: Pick<PromoCampaign, "platforms" | "newPlayersDays">): string {
  const parts: string[] = [];
  if (campaign.newPlayersDays !== null) parts.push(`новички до ${String(campaign.newPlayersDays)} ${plural(campaign.newPlayersDays, ["дня", "дней", "дней"])}`);
  if (campaign.platforms.length > 0) parts.push(campaign.platforms.map((platform) => PLATFORM_TITLES[platform] ?? platform).join(", "));
  return parts.length === 0 ? "все игроки" : parts.join(" · ");
}

/**
 * На какой раскладке игрок наберёт код. Сервер сводит к латинице только
 * кириллицу, которую на глаз не отличить от латиницы (А, В, Е, К, М, Н, О,
 * Р, С, Т, Х, У): «РУБЕЖ» и «RUBEZH» для него разные коды. Это стоит
 * сказать команде до заведения — на стриме код называют голосом.
 */
export function layoutHint(display: string): { tone: "info" | "warning"; text: string } {
  const upper = display.toUpperCase();
  const russianOnly = /[БГДЖЗИЙЛПФЦЧШЩЪЫЬЭЮЯ]/.test(upper);
  const latinOnly = /[DFGIJLNQRSUVWZ]/.test(upper);
  if (russianOnly && latinOnly) return { tone: "warning", text: "Русские и латинские буквы вперемешку — набрать такой код можно, только переключая раскладку. Лучше на одном языке" };
  if (russianOnly) return { tone: "info", text: "Русские буквы: игрок наберёт код на русской раскладке; латиницей он не найдётся" };
  if (latinOnly) return { tone: "info", text: "Латинские буквы: игрок наберёт код на английской раскладке; кириллицей он не найдётся" };
  return { tone: "info", text: "Буквы есть на обеих раскладках — код набирается с любой" };
}

/** Буквы кодов, которые предлагает кнопка «Придумать», — те же, что у пачки на сервере: их набирают с любой раскладки. */
export const CODE_ALPHABET = "ACEHKMPTXY2345679";

export function randomCode(length = 8, random: (size: number) => number = cryptoIndex): string {
  let code = "";
  for (let index = 0; index < length; index += 1) code += CODE_ALPHABET.charAt(random(CODE_ALPHABET.length));
  return code;
}

function cryptoIndex(size: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) % size;
}

/** Коды пачки файлом для таблицы: код, активирован ли и когда. Разделитель — точка с запятой: так файл открывает Excel с русской локалью. */
export function codesCsv(codes: PromoCampaignDetail["codes"]): string {
  const rows = codes.map((code) => `${code.display};${code.redeemedAt === null ? "нет" : "да"};${code.redeemedAt ?? ""}`);
  return ["код;активирован;когда (UTC)", ...rows].join("\r\n");
}

// --- Форма мастера ---

export interface PromoCodeForm {
  /** чей код: id партнёра; пусто — подарок команды */
  partnerId: string;
  kind: "shared" | "batch";
  code: string;
  unlimited: boolean;
  maxRedemptions: number;
  count: number;
  prefix: string;
  reward: Reward;
  /** `now` — начать сразу */
  startMode: "now" | "at";
  /** значение поля `datetime-local` в часах браузера */
  startsAt: string;
  endMode: "never" | "at";
  endsAt: string;
  platforms: string[];
  newOnly: boolean;
  newPlayersDays: number;
  title: string;
  note: string;
  message: string;
}

export interface CreateBody {
  title: string;
  note: string | null;
  message: string | null;
  reward: Reward;
  startsAt: string;
  endsAt: string | null;
  newPlayersDays: number | null;
  platforms: string[];
  issue: { kind: "shared"; code: string; maxRedemptions: number | null } | { kind: "batch"; count: number; prefix: string };
  partnerId: string | null;
}

export type UpdateBody = Omit<CreateBody, "issue" | "partnerId"> & { maxRedemptions: number | null };

/** Значение для `datetime-local` в часах браузера: «2026-10-12T18:00». */
export function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DAY_MS = 86_400_000;

export function emptyForm(now: Date): PromoCodeForm {
  return {
    partnerId: "",
    kind: "shared",
    code: "",
    unlimited: true,
    maxRedemptions: 100,
    count: 50,
    prefix: "",
    reward: { coins: 1_000, gems: 0, shard_common: 0, shard_uncommon: 0 },
    startMode: "now",
    startsAt: localInput(now),
    endMode: "at",
    endsAt: localInput(new Date(now.getTime() + 7 * DAY_MS)),
    platforms: [],
    newOnly: false,
    newPlayersDays: 7,
    title: "",
    note: "",
    message: "",
  };
}

export function formOf(campaign: PromoCampaign): PromoCodeForm {
  return {
    partnerId: campaign.partnerId ?? "",
    kind: campaign.kind,
    code: campaign.codeSample,
    unlimited: campaign.maxRedemptions === null,
    maxRedemptions: campaign.maxRedemptions ?? 100,
    count: campaign.maxRedemptions ?? 0,
    prefix: "",
    reward: { ...campaign.reward },
    startMode: "at",
    startsAt: localInput(new Date(campaign.startsAt)),
    endMode: campaign.endsAt === null ? "never" : "at",
    endsAt: campaign.endsAt === null ? localInput(new Date(new Date(campaign.startsAt).getTime() + 7 * DAY_MS)) : localInput(new Date(campaign.endsAt)),
    platforms: [...campaign.platforms],
    newOnly: campaign.newPlayersDays !== null,
    newPlayersDays: campaign.newPlayersDays ?? 7,
    title: campaign.title,
    note: campaign.note ?? "",
    message: campaign.message ?? "",
  };
}

/** Начало и конец формы в абсолютном времени; «сразу» — момент отправки. */
export function periodOf(form: PromoCodeForm, now: Date): { startsAt: Date; endsAt: Date | null } {
  const startsAt = form.startMode === "now" ? now : new Date(form.startsAt);
  return { startsAt, endsAt: form.endMode === "never" ? null : new Date(form.endsAt) };
}

const optional = (value: string): string | null => (value.trim() === "" ? null : value.trim());

function commonBodyOf(form: PromoCodeForm, now: Date): Omit<CreateBody, "issue" | "partnerId"> {
  const { startsAt, endsAt } = periodOf(form, now);
  return {
    title: form.title.trim(),
    note: optional(form.note),
    message: optional(form.message),
    reward: { ...form.reward },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt?.toISOString() ?? null,
    newPlayersDays: form.newOnly ? form.newPlayersDays : null,
    platforms: [...form.platforms],
  };
}

export function createBodyOf(form: PromoCodeForm, now: Date): CreateBody {
  return {
    ...commonBodyOf(form, now),
    issue: form.kind === "shared" ? { kind: "shared", code: form.code.trim(), maxRedemptions: form.unlimited ? null : form.maxRedemptions } : { kind: "batch", count: form.count, prefix: form.prefix.trim() },
    partnerId: form.partnerId === "" ? null : form.partnerId,
  };
}

/** Правка: начало не трогаем, если код уже начался, — сервер сверяет его до миллисекунды. */
export function updateBodyOf(form: PromoCodeForm, campaign: PromoCampaign, now: Date): UpdateBody {
  const rest = commonBodyOf(form, now);
  const started = new Date(campaign.startsAt).getTime() <= now.getTime();
  return {
    ...rest,
    startsAt: started ? campaign.startsAt : rest.startsAt,
    maxRedemptions: campaign.kind === "batch" ? campaign.maxRedemptions : form.unlimited ? null : form.maxRedemptions,
  };
}

const intIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

/**
 * Проверка формы по пределам сервера — ошибкой у своего поля. `editing` —
 * правка заведённого: то, что после активаций не меняется, не проверяется.
 */
export function formSchema(limits: PromoCodeLimits, now: () => Date, editing: PromoCampaign | null) {
  return z
    .object({
      partnerId: z.string(),
      kind: z.enum(["shared", "batch"]),
      code: z.string(),
      unlimited: z.boolean(),
      maxRedemptions: z.number(),
      count: z.number(),
      prefix: z.string(),
      reward: z.object({ coins: z.number(), gems: z.number(), shard_common: z.number(), shard_uncommon: z.number() }),
      startMode: z.enum(["now", "at"]),
      startsAt: z.string(),
      endMode: z.enum(["never", "at"]),
      endsAt: z.string(),
      platforms: z.array(z.string()),
      newOnly: z.boolean(),
      newPlayersDays: z.number(),
      title: z.string(),
      note: z.string(),
      message: z.string(),
    })
    .superRefine((form, ctx) => {
      const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
      const at = now();

      if (editing === null) {
        if (form.kind === "shared") {
          const length = form.code.replace(/[\s\-_.]/g, "").length;
          if (length === 0) issue(["code"], "Придумайте код — его игрок введёт в игре");
          else if (length < limits.codeMinLength) issue(["code"], `Не короче ${String(limits.codeMinLength)} знаков — короткий код угадывают перебором`);
          else if (length > limits.codeMaxLength) issue(["code"], `Не длиннее ${String(limits.codeMaxLength)} знаков без пробелов и дефисов`);
        } else {
          if (!intIn(form.count, 1, limits.batchMax)) issue(["count"], `От 1 до ${formatNumber(limits.batchMax)} кодов`);
          const prefix = form.prefix.trim();
          if (prefix !== "" && !/^[A-Za-zА-Яа-яЁё0-9]+$/.test(prefix)) issue(["prefix"], "Одно слово из букв и цифр");
          else if (prefix.length > limits.prefixMaxLength) issue(["prefix"], `Не длиннее ${String(limits.prefixMaxLength)} знаков`);
        }
      }
      if (form.kind === "shared" && !form.unlimited) {
        const floor = Math.max(1, editing?.redeemed ?? 0);
        if (!intIn(form.maxRedemptions, floor, limits.maxRedemptions)) {
          issue(["maxRedemptions"], editing !== null && editing.redeemed > 0 ? `Не меньше уже сделанных активаций — ${formatNumber(editing.redeemed)}` : "Целое число больше нуля");
        }
      }

      const rewardLocked = editing !== null && editing.redeemed > 0;
      if (!rewardLocked) {
        for (const resource of REWARD_RESOURCES) {
          if (!intIn(form.reward[resource], 0, limits.reward[resource])) issue(["reward", resource], `От 0 до ${formatNumber(limits.reward[resource])}`);
        }
        if (REWARD_RESOURCES.every((resource) => !(form.reward[resource] > 0))) issue(["reward", "coins"], "Код без награды не нужен — задайте хотя бы одно");
      }

      const startLocked = editing !== null && new Date(editing.startsAt).getTime() <= at.getTime();
      const { startsAt, endsAt } = periodOf(form, at);
      if (!startLocked && form.startMode === "at") {
        if (Number.isNaN(startsAt.getTime())) issue(["startsAt"], "Укажите дату и время");
        else if (startsAt.getTime() < at.getTime() - 60_000) issue(["startsAt"], "Начало — в прошлом: выберите «сразу»");
        else if (startsAt.getTime() > at.getTime() + limits.aheadDays * DAY_MS) issue(["startsAt"], `Не дальше чем через ${String(limits.aheadDays)} дней`);
      }
      if (form.endMode === "at") {
        const start = startLocked && editing !== null ? new Date(editing.startsAt) : startsAt;
        const endChanged = editing === null || editing.endsAt === null || new Date(editing.endsAt).getTime() !== endsAt?.getTime();
        if (endsAt === null || Number.isNaN(endsAt.getTime())) issue(["endsAt"], "Укажите дату и время");
        else if (endsAt.getTime() - start.getTime() < limits.minHours * 3_600_000) issue(["endsAt"], "Код должен действовать хотя бы час после начала");
        else if (endChanged && endsAt.getTime() <= at.getTime()) issue(["endsAt"], "Конец — в прошлом; остановить код сейчас — пауза в карточке");
      }

      if (form.newOnly && !intIn(form.newPlayersDays, 1, limits.newPlayersMaxDays)) issue(["newPlayersDays"], `От 1 до ${String(limits.newPlayersMaxDays)} дней`);
      if (form.title.trim().length < 2) issue(["title"], "Назовите код для команды: «Стрим 12 октября»");
      else if (form.title.trim().length > limits.titleMax) issue(["title"], `Не длиннее ${String(limits.titleMax)} знаков`);
      if (form.note.trim().length > limits.noteMax) issue(["note"], `Не длиннее ${String(limits.noteMax)} знаков`);
      if (form.message.trim().length > limits.messageMax) issue(["message"], `Не длиннее ${String(limits.messageMax)} знаков`);
    });
}
