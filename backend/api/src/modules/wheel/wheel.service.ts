import { randomInt } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ProgressService } from "../progress/progress.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { WheelSpentError } from "./wheel-errors.js";
import { WHEEL_SECTORS, pickSector, sectorAt, sectorOdds, sectorReward, totalWeight, type WheelResource } from "./wheel-rules.js";
import { WHEEL_REPOSITORY, type WheelRepository, type WheelSpinRow } from "./wheel.repository.js";

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
 * Крутка за рекламу — с проверкой просмотра (WP12): до неё сервер знает
 * только бесплатную.
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
    @Inject(WHEEL_ROLL) private readonly roll: WheelRoll,
  ) {}

  async view(accountId: string, at = new Date()): Promise<WheelView> {
    const [today, level] = await Promise.all([this.freeToday(accountId, at), this.level(accountId)]);
    return viewOf(level, freeWaits(today));
  }

  async spin(accountId: string, at = new Date()): Promise<WheelSpinResult> {
    const level = await this.level(accountId);
    const sector = pickSector(WHEEL_SECTORS, this.roll(totalWeight(WHEEL_SECTORS)));
    const reward = sectorReward(sectorAt(WHEEL_SECTORS, sector), level);

    let spin = await withTimeout(this.repository.insertFree(accountId, { sector, ...reward }, at), DB_TIMEOUT_MS, "колесо");
    if (spin === null) {
      // Сутки уже крутили. Не начислено — прошлый запрос оборвался после
      // записи сектора: дожимается он, а не новый бросок.
      spin = await this.freeToday(accountId, at);
      if (spin === null || spin.granted) throw new WheelSpentError();
    }

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
    this.logger.log(JSON.stringify({ module: "wheel", event: "wheel_spun", accountId, source: "free", sector: spin.sector, resource: spin.resource, credited: granted.credited }));
    return { sector: spin.sector, resource: spin.resource, amount: spin.amount, credited: granted.credited, view: viewOf(level, false) };
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

export function viewOf(level: number, free: boolean): WheelView {
  const odds = sectorOdds(WHEEL_SECTORS);
  return {
    sectors: WHEEL_SECTORS.map((sector, index) => ({ ...sectorReward(sector, level), odds: odds[index] ?? 0 })),
    free,
  };
}
