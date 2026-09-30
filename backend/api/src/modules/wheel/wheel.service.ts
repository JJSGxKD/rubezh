import { randomInt } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { ProgressService } from "../progress/progress.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { WheelSpentError } from "./wheel-errors.js";
import { WHEEL_SECTORS, pickSector, sectorAt, sectorOdds, sectorReward, totalWeight, type WheelResource } from "./wheel-rules.js";
import { WHEEL_REPOSITORY, type NewWheelSpin, type WheelRepository, type WheelSpinRow } from "./wheel.repository.js";

/**
 * Колесо (docs/35-stage4-plan.md Р45, §3.14, WP13; docs/07-monetization-and-ads.md
 * §7). Сектор выбирает сервер — клиент только докручивает колесо до него; по
 * броску на устройстве колесо крутили бы до джекпота.
 *
 * Крутка — запись сектора, потом начисление ключом крутки, потом отметка.
 * Сектор записан до начисления, поэтому повтор после сбоя дожимает тот же
 * сектор, а не бросает заново: иначе обрыв сети посреди крутки давал бы
 * вторую попытку. Две крутки разом упираются в ключ суток в базе.
 *
 * Крутка за рекламу (WP12) — с проверкой показа: колесо забирает
 * досмотренную сессию места `wheel_spin` у модуля рекламы, а тот держит
 * растущий кулдаун. Одна сессия — одна крутка: сектор записан с ключом
 * сессии, и повтор после обрыва дожимает тот же сектор.
 */

const DB_TIMEOUT_MS = 3_000;

/** Бросок: целое от нуля до `bound`, не включая. В тестах — предсказуемый. */
export type WheelRoll = (bound: number) => number;
export const WHEEL_ROLL = Symbol("WHEEL_ROLL");
export const cryptoRoll: WheelRoll = (bound) => randomInt(bound);

export interface WheelSectorView {
  resource: WheelResource;
  amount: number;
  /** шанс — доля от единицы */
  odds: number;
}

export interface WheelView {
  /** по часовой стрелке от стрелки — в этом порядке их рисует клиент */
  sectors: WheelSectorView[];
  /** бесплатная крутка этих суток ещё ждёт */
  free: boolean;
  /**
   * Крутка за рекламу: есть ли для площадки рекламные блоки места и когда
   * пройдёт кулдаун (`null` — уже можно).
   */
  ad: { available: boolean; readyAt: string | null };
}

/** Чем крутят: бесплатная крутка суток или досмотренная реклама. */
export type WheelSource = { kind: "free" } | { kind: "ad"; sessionId: string };

/** Кто крутит: площадка нужна, чтобы знать, есть ли для неё реклама. */
export interface WheelPlayer {
  accountId: string;
  platform: PlatformId;
}

export interface WheelSpinResult {
  sector: number;
  resource: WheelResource;
  amount: number;
  /** сколько легло на баланс: меньше `amount`, если упёрлось в суточный потолок */
  credited: number;
  view: WheelView;
}

@Injectable()
export class WheelService {
  private readonly logger = new Logger("wheel");

  constructor(
    @Inject(WHEEL_REPOSITORY) private readonly repository: WheelRepository,
    private readonly progress: ProgressService,
    private readonly wallet: WalletService,
    private readonly ads: AdsService,
    @Inject(WHEEL_ROLL) private readonly roll: WheelRoll,
  ) {}

  async view(player: WheelPlayer, at = new Date()): Promise<WheelView> {
    const [today, level, ad] = await Promise.all([this.freeToday(player.accountId, at), this.level(player.accountId), this.adReadiness(player, at)]);
    return viewOf(level, freeWaits(today), ad);
  }

  async spin(player: WheelPlayer, source: WheelSource, at = new Date()): Promise<WheelSpinResult> {
    const { accountId } = player;
    const level = await this.level(accountId);
    const sector = pickSector(WHEEL_SECTORS, this.roll(totalWeight(WHEEL_SECTORS)));
    const reward = sectorReward(sectorAt(WHEEL_SECTORS, sector), level);
    const spin = source.kind === "free" ? await this.freeSpin(accountId, { sector, ...reward }, at) : await this.adSpin(accountId, source.sessionId, { sector, ...reward }, at);

    const granted = await this.wallet.grant({
      accountId,
      resource: spin.resource,
      amount: spin.amount,
      reason: "wheel_reward",
      source: `wheel:${spin.spinId}`,
      idempotencyKey: `wheel_reward:${spin.spinId}`,
      at,
    });
    await withTimeout(this.repository.markGranted(spin.spinId, at), DB_TIMEOUT_MS, "колесо");
    this.logger.log(JSON.stringify({ module: "wheel", event: "wheel_spun", accountId, source: source.kind, sector: spin.sector, resource: spin.resource, credited: granted.credited }));
    // После бесплатной крутки её больше нет; после рекламной бесплатная могла остаться.
    const [free, ad] = await Promise.all([source.kind === "free" ? false : this.freeToday(accountId, at).then(freeWaits), this.adReadiness(player, at)]);
    return { sector: spin.sector, resource: spin.resource, amount: spin.amount, credited: granted.credited, view: viewOf(level, free, ad) };
  }

  private async freeSpin(accountId: string, pick: NewWheelSpin, at: Date): Promise<WheelSpinRow> {
    const spin = await withTimeout(this.repository.insertFree(accountId, pick, at), DB_TIMEOUT_MS, "колесо");
    if (spin !== null) return spin;
    // Сутки уже крутили. Не начислено — прошлый запрос оборвался после
    // записи сектора: дожимается он, а не новый бросок.
    const today = await this.freeToday(accountId, at);
    if (today === null || today.granted) throw new WheelSpentError();
    return today;
  }

  /**
   * Сначала забор сессии: недосмотренная, чужая или в кулдаун — отказ
   * модуля рекламы с его кодом. Забранная раньше отдаётся повтором — тогда
   * сектор уже записан с её ключом и дожимается он, а не новый бросок.
   */
  private async adSpin(accountId: string, sessionId: string, pick: NewWheelSpin, at: Date): Promise<WheelSpinRow> {
    await this.ads.claim(accountId, sessionId, "wheel_spin", at);
    const spin = await withTimeout(this.repository.insertAd(accountId, sessionId, pick, at), DB_TIMEOUT_MS, "колесо");
    if (spin !== null) return spin;
    const earlier = await withTimeout(this.repository.byAdSession(accountId, sessionId), DB_TIMEOUT_MS, "колесо");
    if (earlier === null) throw new WheelSpentError();
    return earlier;
  }

  private async adReadiness(player: WheelPlayer, at: Date): Promise<WheelView["ad"]> {
    const ready = await this.ads.readiness(player, "wheel_spin", at);
    return { available: ready.available, readyAt: ready.readyAt?.toISOString() ?? null };
  }

  /** Знак меню: 1 — бесплатная крутка этих суток ждёт. */
  async badge(accountId: string, at = new Date()): Promise<number> {
    return freeWaits(await this.freeToday(accountId, at)) ? 1 : 0;
  }

  private async freeToday(accountId: string, at: Date): Promise<WheelSpinRow | null> {
    return await withTimeout(this.repository.freeToday(accountId, at), DB_TIMEOUT_MS, "колесо");
  }

  private async level(accountId: string): Promise<number> {
    return (await this.progress.view(accountId)).level;
  }
}

/** Крутка ждёт, пока её не крутили — или крутили, но начисление оборвалось. */
function freeWaits(today: WheelSpinRow | null): boolean {
  return today === null || !today.granted;
}

export function viewOf(level: number, free: boolean, ad: WheelView["ad"]): WheelView {
  const odds = sectorOdds(WHEEL_SECTORS);
  return {
    sectors: WHEEL_SECTORS.map((sector, index) => ({ ...sectorReward(sector, level), odds: odds[index] ?? 0 })),
    free,
    ad,
  };
}
