import type { PlatformId } from "../../platforms/ports/platform.js";
import type { AdPlace, AdSuccess } from "./ads-rules.js";

/**
 * Профили рекламных сетей (docs/35-stage4-plan.md WP12, часть 5): что сеть
 * умеет и что ей нужно. У каждой сети свой SDK, поэтому сеть приходит кодом, а
 * профиль — рядом с ним: панель строит по нему формы, сервер проверяет ключи и
 * блоки, выдача показа отдаёт клиенту ровно то, что ждёт SDK.
 *
 * **Место задаёт формат.** Второй шанс, колесо и удвоение — видео за награду;
 * «между забегами» — межстраничная; задания — задание сети. Блок сети встаёт
 * только в место своего формата и только с идентификатором его вида: задание
 * AdsGram (`task-…`) на крутку колеса не поставить — у колеса другой формат.
 *
 * **Ключи сети публичные** — их всё равно видно в коде клиента: `pubId`,
 * `appId`. Секреты подтверждений (вебхуки, адрес награды) — только в
 * окружении (Р53) и сюда не попадают.
 *
 * **Сеть знает свои площадки** (Р77, часть 8): SDK AdsGram, AdSonar, RichAds
 * и Taddy живёт только в Telegram. Блок с чужой площадкой не сохраняется и не
 * выдаётся, а пустой список площадок у блока значит «везде, где работает
 * сеть», — иначе блок AdsGram «на всех площадках» считался бы рекламой в VK.
 *
 * `verified` — профиль сверен с документацией сети (все четыре — 01.10.2026)
 * и рабочей интеграцией источника (`vpnsibcom_web`: вид ключей в продакшене).
 * Новая сеть без сверки заводится с `false` — панель так и пишет: «сверить с
 * кабинетом».
 */

export const AD_FORMATS = ["rewarded", "interstitial", "task"] as const;
export type AdFormat = (typeof AD_FORMATS)[number];

/** Какой рекламы ждёт место: награда за досмотр, полноэкранная без награды или задание. */
export const PLACE_FORMAT: Record<AdPlace, AdFormat> = {
  second_chance: "rewarded",
  wheel_spin: "rewarded",
  run_double: "rewarded",
  task: "task",
  interstitial: "interstitial",
};

/** Место словами — в сообщениях панели, как в разделе «Реклама». */
export const PLACE_TITLES: Record<AdPlace, string> = {
  second_chance: "Второй шанс",
  wheel_spin: "Крутка колеса",
  run_double: "Удвоение за забег",
  task: "Задания",
  interstitial: "Между забегами",
};

export const SUCCESS_TITLES: Record<AdSuccess, string> = { view: "показ", click: "клик", cpa: "целевое действие" };

/** Площадка словами — в сообщениях панели: «работает только в Telegram». */
export const PLATFORM_TITLES: Record<PlatformId, string> = { telegram: "Telegram", max: "MAX", vk: "VK", web: "браузере" };

export const FORMAT_TITLES: Record<AdFormat, string> = {
  rewarded: "видео за награду",
  interstitial: "полноэкранная без награды",
  task: "задание сети",
};

/** Поле, которое вводят из кабинета сети: ключ сети или идентификатор блока. */
export interface AdField {
  title: string;
  /** где взять и как выглядит — подсказка под полем */
  hint: string;
  /** пример значения — плейсхолдер поля и проверка самого профиля */
  example: string;
  /** регулярное выражение целиком, с `^` и `$` — строкой: его же исполняет панель */
  pattern: string;
  /** значение — из списка, а не из кабинета: панель рисует выбор, `pattern` перечисляет те же значения */
  options?: readonly AdFieldOption[];
}

export interface AdFieldOption {
  value: string;
  title: string;
  /** чем вариант отличается — особенно в деньгах и подтверждении */
  hint: string;
}

export interface AdKeyField extends AdField {
  key: string;
}

export interface AdFormatSupport {
  format: AdFormat;
  /** как формат называется у сети и чем показывается */
  title: string;
  /** идентификатор блока в кабинете; `null` — блока нет, показ идёт по ключам сети */
  unit: AdField | null;
  /** условия успеха, допустимые для формата; первое — по умолчанию */
  success: readonly AdSuccess[];
  /** сколько включённых блоков формата держит кабинет сети; не задано — сколько угодно */
  maxActive?: number;
  /** что важно знать о формате — показывается в панели */
  note?: string;
}

export interface AdNetworkProfile {
  key: string;
  title: string;
  /** кабинет сети — ссылка в панели; `null` — адрес не сверен */
  cabinet: string | null;
  /** площадки, где работает SDK сети, — блок показывается только на них */
  platforms: readonly PlatformId[];
  keys: readonly AdKeyField[];
  formats: readonly AdFormatSupport[];
  verified: boolean;
}

export const AD_NETWORK_PROFILES: readonly AdNetworkProfile[] = [
  {
    key: "adsgram",
    title: "AdsGram",
    cabinet: "https://partner.adsgram.ai",
    platforms: ["telegram"],
    keys: [],
    formats: [
      {
        format: "rewarded",
        title: "Reward — видео до конца (`Adsgram.init` + `show`, событие `onReward`)",
        unit: { title: "Block ID", hint: "Кабинет AdsGram → блок формата Reward → настройки: число без приставки", example: "12345", pattern: "^[0-9]{1,12}$" },
        success: ["view"],
      },
      {
        format: "interstitial",
        title: "Interstitial — полноэкранная (`Adsgram.init` + `show`, событие `onComplete`)",
        unit: { title: "Block ID", hint: "Кабинет AdsGram → блок формата Interstitial: приставка int- и число", example: "int-12345", pattern: "^int-[0-9]{1,12}$" },
        success: ["view"],
      },
      {
        format: "task",
        title: "Task — задание сети (`<adsgram-task>`, событие `reward`)",
        unit: { title: "Block ID", hint: "Кабинет AdsGram → блок формата Task: приставка task- и число", example: "task-12345", pattern: "^task-[0-9]{1,12}$" },
        success: ["cpa"],
        maxActive: 1,
        note: "В кабинете AdsGram Task-блок один на аккаунт. Награда — по адресу награды AdsGram, серверным подтверждением.",
      },
    ],
    verified: true,
  },
  {
    key: "adsonar",
    title: "AdSonar",
    cabinet: "https://partner.adsonar.co",
    platforms: ["telegram"],
    keys: [
      {
        key: "appId",
        title: "Application ID",
        hint: "partner.adsonar.co → приложение → идентификатор: app_ и буквы с цифрами; уходит в адрес скрипта sonar.js",
        example: "app_133d2148",
        pattern: "^app_[0-9a-z]{4,32}$",
      },
    ],
    formats: [
      {
        format: "rewarded",
        title: "Rewarded (`Sonar.show`, событие `onReward`)",
        unit: { title: "Ad Unit", hint: "partner.adsonar.co → Create Ad Unit → тип Rewarded: имя блока", example: "rewarded_wheel", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        success: ["view"],
        note: "Метод показа у всех форматов один — формат задаёт сам блок в кабинете: блок этого места должен быть типа Rewarded.",
      },
      {
        format: "interstitial",
        title: "Interstitial (`Sonar.show`, закрывает игрок — `onClose`)",
        unit: { title: "Ad Unit", hint: "partner.adsonar.co → Create Ad Unit → тип Interstitial: имя блока", example: "interstitial_between", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        success: ["view"],
        note: "Блок этого места в кабинете — типа Interstitial. Баннер (контейнер на странице) в места игры не ложится.",
      },
    ],
    verified: true,
  },
  {
    key: "richads",
    title: "RichAds",
    cabinet: "https://my.richads.com",
    platforms: ["telegram"],
    keys: [
      { key: "pubId", title: "Publisher ID (pubId)", hint: "Код подключения Mini App от RichAds: число pubId в initialize", example: "792361", pattern: "^[0-9]{1,12}$" },
      { key: "appId", title: "App ID (appId)", hint: "Код подключения Mini App от RichAds: число appId в initialize — у каждого приложения своё", example: "1396", pattern: "^[0-9]{1,12}$" },
    ],
    formats: [
      {
        format: "rewarded",
        title: "Video Ads (`TelegramAdsController.triggerInterstitialVideo`, resolve — досмотрено)",
        unit: null,
        success: ["view"],
        note: "Блока в кабинете нет: показ идёт по pubId и appId сети.",
      },
      {
        format: "interstitial",
        title: "Interstitial Banner (`TelegramAdsController.triggerInterstitialBanner`)",
        unit: null,
        success: ["view"],
        note: "Блока в кабинете нет: показ идёт по pubId и appId сети. Push style и встроенный баннер в места игры не ложатся.",
      },
    ],
    verified: true,
  },
  {
    key: "taddy",
    title: "Taddy",
    cabinet: null,
    platforms: ["telegram"],
    keys: [
      {
        key: "pubId",
        title: "pubId (ID ресурса)",
        hint: "Выдаёт команда Taddy при подключении — самостоятельной регистрации нет. У Mini App — 32 знака 0–9 и a–f, у бота — с приставкой bot-",
        example: "14cbeb980853dd416003462ca4db7c12",
        pattern: "^(?:[0-9a-f]{32}|bot-[A-Za-z0-9_-]{4,60})$",
      },
    ],
    formats: [
      {
        format: "rewarded",
        title: "Interstitial до конца (`taddy.ads().interstitial`, событие `onViewThrough`)",
        unit: null,
        success: ["view"],
        note: "Блока нет: показ по pubId. Досмотр до конца подтверждает и сервер Taddy — вебхуком ads.view_through.",
      },
      {
        format: "interstitial",
        title: "Interstitial (`taddy.ads().interstitial`)",
        unit: null,
        success: ["view"],
        note: "Блока нет: показ идёт по pubId.",
      },
      {
        format: "task",
        title: "Задания Taddy — обмен трафиком или рекламные задания",
        unit: {
          title: "Источник заданий",
          hint: "Taddy отдаёт задания двумя путями — у каждого своя экономика и своё подтверждение",
          example: "exchange",
          pattern: "^(?:exchange|app-task)$",
          options: [
            {
              value: "exchange",
              title: "Обмен трафиком (`exchange.feed`)",
              hint: "Taddy за них не платит: выполнение приводит в игру новых игроков из сети обмена. Выполнение сервер проверяет сам — exchange/check по API.",
            },
            {
              value: "app-task",
              title: "Рекламные задания (`ads/get`, формат app-task)",
              hint: "Оплачиваемые CPA и CPC. Подписка должна продержаться 48–72 часа — около 35% отписываются, и оплата сгорает. Награда — по вебхуку статуса лида, цены в ответе нет.",
            },
          ],
        },
        success: ["cpa"],
        note: "Награда — только после подтверждения Taddy: проверкой выполнения или вебхуком лида. Клиенту на слово не верим.",
      },
    ],
    verified: true,
  },
];

export function profileOf(networkKey: string): AdNetworkProfile | undefined {
  return AD_NETWORK_PROFILES.find((profile) => profile.key === networkKey);
}

/** Формат сети для места; `undefined` — сеть в этом месте не показывает. */
export function formatFor(profile: AdNetworkProfile, place: AdPlace): AdFormatSupport | undefined {
  return profile.formats.find((support) => support.format === PLACE_FORMAT[place]);
}

/** Места, в которых сеть показывает, — по её форматам. */
export function placesOf(profile: AdNetworkProfile, places: readonly AdPlace[]): AdPlace[] {
  return places.filter((place) => formatFor(profile, place) !== undefined);
}

function matches(field: AdField, value: string): boolean {
  return new RegExp(field.pattern).test(value);
}

/** Что не так с ключами сети; `null` — всё заполнено и по виду. Пустая строка — ключа нет. */
export function keysProblem(profile: AdNetworkProfile, keys: Readonly<Record<string, string>>): string | null {
  const unknown = Object.keys(keys).find((key) => !profile.keys.some((field) => field.key === key));
  if (unknown !== undefined) return `У ${profile.title} нет ключа «${unknown}»`;
  for (const field of profile.keys) {
    const value = keys[field.key] ?? "";
    if (value !== "" && !matches(field, value)) return `${field.title}: не похоже на значение из кабинета — пример «${field.example}»`;
  }
  return null;
}

/** Каких ключей не хватает, чтобы сеть могла показывать; пусто — хватает. */
export function missingKeys(profile: AdNetworkProfile, keys: Readonly<Record<string, string>>): string[] {
  return profile.keys.filter((field) => (keys[field.key] ?? "") === "").map((field) => field.title);
}

export interface BlockShape {
  networkKey: string;
  place: AdPlace;
  externalId: string | null;
  success: AdSuccess;
  /** пусто — везде, где работает сеть */
  platforms: readonly PlatformId[];
}

const listOf = (platforms: readonly PlatformId[]): string => platforms.map((platform) => PLATFORM_TITLES[platform]).join(", ");

/** Что не так с блоком по профилю его сети; `null` — блок по правилам. */
export function blockShapeProblem(block: BlockShape): string | null {
  const profile = profileOf(block.networkKey);
  if (profile === undefined) return `Сети «${block.networkKey}» нет в коде — её SDK не подключён`;
  const foreign = block.platforms.filter((platform) => !profile.platforms.includes(platform));
  if (foreign.length > 0) return `${profile.title} работает только в ${listOf(profile.platforms)} — в ${listOf(foreign)} её SDK не поднимется`;
  const support = formatFor(profile, block.place);
  if (support === undefined) {
    return `${profile.title} не показывает в месте «${PLACE_TITLES[block.place]}»: месту нужен формат «${FORMAT_TITLES[PLACE_FORMAT[block.place]]}», а у сети его нет`;
  }
  if (support.unit === null) {
    if (block.externalId !== null) return `${profile.title}: у формата нет блока в кабинете — показ идёт по ключам сети`;
  } else {
    if (block.externalId === null) return `${profile.title}: нужен ${support.unit.title} из кабинета — пример «${support.unit.example}»`;
    if (!matches(support.unit, block.externalId)) return `${profile.title}: ${support.unit.title} для этого места выглядит как «${support.unit.example}»`;
  }
  if (!support.success.includes(block.success)) return `${profile.title}: в этом месте успех — ${support.success.map((success) => SUCCESS_TITLES[success]).join(" или ")}`;
  return null;
}

/** Показывается ли блок на площадке: сеть там работает, а блок не ограничен другими. */
export function blockReaches(block: Pick<BlockShape, "networkKey" | "platforms">, platform: PlatformId): boolean {
  const profile = profileOf(block.networkKey);
  if (profile === undefined || !profile.platforms.includes(platform)) return false;
  return block.platforms.length === 0 || block.platforms.includes(platform);
}
