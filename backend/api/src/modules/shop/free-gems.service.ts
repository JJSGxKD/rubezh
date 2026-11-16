import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { FREE_GEMS_REPOSITORY, type FreeGemsRepository, type FreeGemsRow } from "./free-gems.repository.js";
import { FreeGemsClaimedError } from "./shop-errors.js";

/**
 * Самоцветы за ролик раз в игровые сутки (docs/35-stage4-plan.md Р155,
 * tasks/T-0243): магазин — хозяин места рекламы `free_gems`. Игрок досматривает
 * ролик и берёт несколько самоцветов; сколько — ключ панели
 * `ads.free-gems.amount`.
 *
 * Порядок — как у второго шанса и награды дня ×2: проверка, забор сессии,
 * запись, начисление. Проверка идёт до забора, поэтому досмотренная сессия не
 * тратится на сутки, которые уже взяты. Запись неделима (`ON CONFLICT DO
 * NOTHING`): два параллельных запроса дают одно взятие. Повтор той же сессией
 * после обрыва отдаёт тот же ответ и дожимает начисление тем же ключом, а не
 * отказывает; число берётся из записи, а не из ключа панели, который мог
 * измениться между попытками.
 *
 * Дневной кап роликов (T-0241) считает модуль рекламы: место наградное и не
 * задание. У VIP ролика нет — выдача показа отдаёт пропуск.
 */

const DB_TIMEOUT_MS = 3_000;

export interface FreeGemsPlayer {
  accountId: string;
  platform: PlatformId;
}

export type FreeGemsView =
  | {
      status: "available";
      /** сколько самоцветов игрок получит — число ключа панели */
      gems: number;
      /** есть ли реклама для площадки, когда пройдёт кулдаун (у места его нет) и нужен ли ролик (`pass` — VIP без него) */
      ad: { available: boolean; readyAt: string | null; pass: string | null; capped: boolean };
    }
  /** сегодня уже взято: сколько легло */
  | { status: "claimed"; gems: number }
  /** рекламы для площадки нет и пропуска нет — карточку не показывают */
  | { status: "unavailable" };

export interface FreeGemsResult {
  /** сколько самоцветов легло на кошелёк; при повторе той же сессией — то же, что в первый раз */
  credited: number;
  view: FreeGemsView;
}

@Injectable()
export class FreeGemsService {
  private readonly logger = new Logger("shop");

  constructor(
    @Inject(FREE_GEMS_REPOSITORY) private readonly claims: FreeGemsRepository,
    private readonly wallet: WalletService,
    private readonly ads: AdsService,
    // Число читается на каждом запросе: правка из панели действует сразу.
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async view(player: FreeGemsPlayer, at = new Date()): Promise<FreeGemsView> {
    const done = await this.db(this.claims.today(player.accountId, at));
    if (done !== null) return { status: "claimed", gems: done.gems };
    const ready = await this.ads.readiness(player, "free_gems", at);
    // Упёрся в кап — кнопка остаётся и говорит, что ролики кончились; рекламы нет совсем — карточки нет.
    if (!ready.available && !ready.capped) return { status: "unavailable" };
    return {
      status: "available",
      gems: this.amount(),
      ad: { available: ready.available, readyAt: ready.readyAt?.toISOString() ?? null, pass: ready.pass, capped: ready.capped },
    };
  }

  async claim(player: FreeGemsPlayer, sessionId: string, at = new Date()): Promise<FreeGemsResult> {
    const { accountId } = player;

    // Сессия уже потрачена на взятие — обрыв после записи: дожимаем начисление, а не отказываем.
    const spent = await this.db(this.claims.bySession(accountId, sessionId));
    if (spent !== null) return await this.settle(player, spent, at);

    if ((await this.db(this.claims.today(accountId, at))) !== null) throw new FreeGemsClaimedError();

    // Чужая, незавершённая и чужого места сессия, кап роликов, ограничение — отказы модуля рекламы.
    await this.ads.claim(accountId, sessionId, "free_gems", at);
    const outcome = await this.db(this.claims.record({ accountId, sessionId, gems: this.amount() }, at));
    if (outcome === "taken") throw new FreeGemsClaimedError();

    // Записанное — истина: параллельный повтор той же сессией берёт число первой записи, а не своё.
    const row = await this.db(this.claims.bySession(accountId, sessionId));
    if (row === null) throw new FreeGemsClaimedError();
    return await this.settle(player, row, at);
  }

  /** Начислить самоцветы ключом суток и отдать ответ; повтор не начисляет второй раз. */
  private async settle(player: FreeGemsPlayer, row: FreeGemsRow, at: Date): Promise<FreeGemsResult> {
    const { accountId } = player;
    const granted = await this.wallet.grant({
      accountId,
      resource: "gems",
      amount: row.gems,
      reason: "ad_reward",
      source: `free_gems:${row.gameDay}`,
      idempotencyKey: `free_gems:${accountId}:${row.gameDay}`,
      at,
    });
    if (!granted.duplicate) this.logger.log(JSON.stringify({ module: "shop", event: "free_gems_claimed", accountId, day: row.gameDay, gems: granted.credited }));
    return {
      // Повтор отдаёт то же, что первый ответ: кошелёк на дубле говорит «ничего не легло».
      credited: granted.duplicate ? row.gems : granted.credited,
      // Сессия могла остаться со вчерашнего дня: экран получает честное состояние сегодняшних суток.
      view: await this.view(player, at),
    };
  }

  private amount(): number {
    return this.settings.get(SETTINGS.adsFreeGemsAmount);
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "самоцветы за ролик");
  }
}
