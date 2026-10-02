import { Inject, Injectable, Logger } from "@nestjs/common";
import { profileOf } from "./ad-networks.js";
import { AdNetworkKeys } from "./ad-network-keys.js";
import type { TaddyApi, TaddyUser } from "./taddy-api.js";

/**
 * Креативы сетей с API (docs/35-stage4-plan.md WP12, часть 9, Р78): сеть
 * отдаёт объявление серверу, а не SDK на клиенте, и его рисует наш рекламный
 * блок. Сервер же сообщает сети показ и досмотр — клиенту для этого не нужны
 * ни ключи сети, ни её адреса.
 *
 * Пока такая сеть одна — Taddy. Новая сеть с API — ещё одна ветка здесь и
 * `delivery: "api"` у её форматов в профиле.
 */

/**
 * Объявление для нашего блока — зеркало `AdCreative` из `packages/shared-types`:
 * бэкенд пакет не импортирует, а контракт с оболочкой один. Адреса — только https.
 */
export interface AdCreative {
  /** идентификатор у сети — по нему сервер сообщает ей показ */
  id: string;
  title: string | null;
  description: string | null;
  text: string | null;
  image: string | null;
  icon: string | null;
  /** надпись на кнопке; `null` — оболочка подставит свою */
  button: string | null;
  link: string;
  /** чья реклама — для пометки «Реклама»: рекламодатель, если сеть его называет, иначе сама сеть */
  advertiser: string;
}

/** Кто просит рекламу — то, что нужно сети для гео и антифрода. Язык и премиум — со слов клиента. */
export interface AdRequester {
  /** идентификатор на площадке; у Telegram — Telegram ID */
  platformUserId: string;
  /** адрес из `req.ip` — с учётом доверенных прокси, не из сырого заголовка */
  ip: string | null;
  userAgent: string | null;
  language: string | null;
  premium: boolean | null;
}

/** `none` — у сети нет креатива для игрока, и выдача идёт к следующей сети. */
export type CreativeFetch = { kind: "creative"; creative: AdCreative } | { kind: "none"; reason: string };

export interface AdCreativeSource {
  /** `timeoutMs` — сколько ждать сеть; не задан — её обычный срок */
  fetch(networkKey: string, keys: Readonly<Record<string, string>>, requester: AdRequester | null, timeoutMs?: number): Promise<CreativeFetch>;
  /** креатив впервые на экране игрока — сеть считает показ */
  shown(networkKey: string, creativeId: string, requester: AdRequester | null): Promise<void>;
  /** креатив досмотрен — сеть считает досмотр */
  viewed(networkKey: string, creativeId: string, requester: AdRequester | null): Promise<void>;
}

export const AD_CREATIVES = Symbol("AD_CREATIVES");
export const TADDY_API = Symbol("TADDY_API");

/** Язык — основной подтег: Taddy ждёт `ru`, а Telegram отдаёт и `pt-br`. */
export function primaryLanguage(language: string | null): string | null {
  const primary = language?.split("-")[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/**
 * Игрок для Taddy. Telegram ID — числом: без него Taddy объявления не даст,
 * а входа разработчика (`dev-…`) Taddy не знает.
 */
export function taddyUser(requester: AdRequester | null): TaddyUser | null {
  if (requester === null || !/^[1-9][0-9]{0,15}$/.test(requester.platformUserId)) return null;
  const id = Number(requester.platformUserId);
  if (!Number.isSafeInteger(id)) return null;
  const language = primaryLanguage(requester.language);
  return {
    id,
    ...(language === null ? {} : { language }),
    ...(requester.premium === null ? {} : { premium: requester.premium }),
    ...(requester.ip === null ? {} : { ip: requester.ip }),
    ...(requester.userAgent === null ? {} : { userAgent: requester.userAgent }),
  };
}

@Injectable()
export class NetworkCreatives implements AdCreativeSource {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(TADDY_API) private readonly taddy: TaddyApi,
    private readonly keys: AdNetworkKeys,
  ) {}

  async fetch(networkKey: string, keys: Readonly<Record<string, string>>, requester: AdRequester | null, timeoutMs?: number): Promise<CreativeFetch> {
    if (networkKey !== "taddy") return { kind: "none", reason: "unsupported" };
    const pubId = keys["pubId"] ?? "";
    if (pubId === "") return { kind: "none", reason: "misconfigured" };
    const user = taddyUser(requester);
    if (user === null) return { kind: "none", reason: "no_user" };
    const result = await this.taddy.getAd(pubId, user, timeoutMs);
    if (result.kind === "none") return result;
    return { kind: "creative", creative: { ...result.ad, advertiser: profileOf(networkKey)?.title ?? networkKey } };
  }

  async shown(networkKey: string, creativeId: string, requester: AdRequester | null): Promise<void> {
    await this.notify(networkKey, requester, async (pubId, user) => await this.taddy.impression(pubId, user, creativeId));
  }

  async viewed(networkKey: string, creativeId: string, requester: AdRequester | null): Promise<void> {
    await this.notify(networkKey, requester, async (pubId, user) => await this.taddy.viewThrough(pubId, user, creativeId));
  }

  /** Отметка сети — мимо ответа игроку: не дошла — показ уже был, остаётся строка в логе. */
  private async notify(networkKey: string, requester: AdRequester | null, send: (pubId: string, user: TaddyUser) => Promise<void>): Promise<void> {
    if (networkKey !== "taddy") return;
    const user = taddyUser(requester);
    if (user === null) return;
    try {
      const pubId = (await this.keys.of(networkKey))?.["pubId"] ?? "";
      if (pubId !== "") await send(pubId, user);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "ads", event: "network_notify_failed", network: networkKey, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
