import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { SECRETS, type SecretDefinition } from "../secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../secrets/secrets.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { profileOf } from "./ad-networks.js";
import { ADS_REPOSITORY, type AdBlockRow, type AdSessionRow, type AdsRepository, type PlaceHistory } from "./ads.repository.js";
import { AdsService } from "./ads.service.js";

/**
 * Задания рекламных сетей во вкладке «Партнёры» (docs/35-stage4-plan.md
 * WP13, часть 6, Р80). Место `task` выдаёт не круг сетей, а хозяин места —
 * задания: у каждой сети своя строка, свой потолок и своя награда.
 *
 * Модуль рекламы ручается за три вещи:
 * - строка сети есть, пока у сети включён Task-блок для площадки игрока и
 *   есть чем подтвердить выполнение — у AdsGram это адрес награды;
 * - открытая сессия сети у игрока одна: экран заданий открывают десятки
 *   раз, а задание выполняют однажды;
 * - выполнение подтверждает только сеть, а не клиент: сессия задания —
 *   целевое действие, и шаг клиента её не выполнит (`report`).
 *
 * Награду выдаёт хозяин места: подтверждение уходит ему слушателем
 * (`AdTaskHooks`), и он забирает выполненную сессию так же, как колесо —
 * досмотренный ролик.
 */

const DB_TIMEOUT_MS = 3_000;
const MINUTE_MS = 60_000;

/**
 * Сколько живёт сессия задания. AdsGram подтверждает задание за минуты, а
 * приложение, открытое дольше, сеть сама просит перезапустить; сутки
 * покрывают и это с запасом. Истёкшая сессия не выполнится — подтверждение
 * на неё награды не даст.
 */
export const TASK_SESSION_TTL_MIN = 24 * 60;

/**
 * Чем сеть подтверждает задание и что для этого должно быть задано. Сеть
 * без записи заданий игрокам не даёт: награду за них выдать было бы нечем.
 */
export const TASK_CONFIRMATIONS: Readonly<Record<string, { secret: SecretDefinition }>> = {
  adsgram: { secret: SECRETS.adsgramRewardSecret },
};

/** Что клиент передаёт SDK сети, чтобы она нарисовала своё задание. */
export interface AdTaskOffer {
  sessionId: string;
  network: string;
  /** идентификатор блока в кабинете сети — его ждёт SDK */
  blockId: string | null;
  /** публичные ключи сети */
  keys: Record<string, string>;
  /** тестовые задания сети — по настройке из панели */
  debug: boolean;
  expiresAt: string;
}

/** Готовы ли задания сети — для панели. */
export interface TaskReadiness {
  /** включённый блок в месте «Задания» хоть на одной площадке сети */
  block: boolean;
  /** есть чем подтвердить выполнение */
  confirm: boolean;
  /** ключ подтверждения в «Ключах интеграций» — его название; `null` — сеть задания подтверждать не умеет */
  confirmWith: string | null;
}

/** Сеть подтвердила задание игрока — хозяину места пора выдать награду. */
export interface ConfirmedNetworkTask {
  accountId: string;
  networkKey: string;
  sessionId: string;
  /** подтверждение повторное: прошлая выдача сорвалась — выдать тем же ключом */
  repeat: boolean;
  at: Date;
}

export type ConfirmedTaskListener = (task: ConfirmedNetworkTask) => Promise<void>;

/**
 * Слушатель хозяина места `task`. Он один: у места один хозяин. Ждём его до
 * ответа сети — сорвалась выдача, сеть получит ошибку и повторит
 * подтверждение, а повтор выдаст награду тем же ключом.
 */
@Injectable()
export class AdTaskHooks {
  private listener: ConfirmedTaskListener | null = null;

  onConfirmed(listener: ConfirmedTaskListener): void {
    this.listener = listener;
  }

  async emit(task: ConfirmedNetworkTask): Promise<void> {
    if (this.listener === null) throw new Error("у места task нет хозяина — награду за задание сети выдать некому");
    await this.listener(task);
  }
}

/** Чем кончилось подтверждение сети — для ответа ей и лога. */
export type TaskConfirmOutcome = "confirmed" | "unknown_player" | "unmatched";

@Injectable()
export class AdTasks {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(ADS_REPOSITORY) private readonly repository: AdsRepository,
    private readonly ads: AdsService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byPlatformUser">,
    private readonly hooks: AdTaskHooks,
  ) {}

  /** Есть ли чем подтвердить задания сети: у AdsGram — создан ли адрес награды. */
  confirmable(networkKey: string): boolean {
    const confirmation = TASK_CONFIRMATIONS[networkKey];
    return confirmation !== undefined && this.secrets.get(confirmation.secret) !== null;
  }

  /**
   * Task-блок сети для площадки игрока; `null` — заданий сети у него нет:
   * блок выключен, сеть не работает на площадке или подтверждать нечем.
   * Устройство экрану заданий не известно — блок с ограничением по
   * устройству здесь не выдаётся.
   */
  async block(networkKey: string, platform: PlatformId): Promise<AdBlockRow | null> {
    if (!this.confirmable(networkKey)) return null;
    const blocks = await this.ads.servableBlocks("task", { platform, device: null });
    // Task-блок у AdsGram один на кабинет (`maxActive`), и выбирать не из чего.
    return blocks.find((block) => block.networkKey === networkKey) ?? null;
  }

  /**
   * Что нужно, чтобы игроки увидели задания сети, — для панели: включённый
   * блок в месте «Задания» хоть на одной площадке сети и чем подтвердить
   * выполнение.
   */
  async readiness(networkKey: string): Promise<TaskReadiness> {
    const platforms = profileOf(networkKey)?.platforms ?? [];
    const lists = await Promise.all(platforms.map(async (platform) => await this.ads.servableBlocks("task", { platform, device: null })));
    return {
      block: lists.some((blocks) => blocks.some((block) => block.networkKey === networkKey)),
      confirm: this.confirmable(networkKey),
      confirmWith: TASK_CONFIRMATIONS[networkKey]?.secret.title ?? null,
    };
  }

  /** История места `task` с начала вчерашних игровых суток — по ней хозяин считает потолок и паузу. */
  async history(accountId: string, at: Date): Promise<PlaceHistory> {
    return await this.db(this.repository.history(accountId, "task", at));
  }

  /**
   * Сессия задания сети: открытая — та же; новую заводит только `admit`
   * хозяина по истории места — под блокировкой, так что два экрана разом
   * потолок не обойдут. `null` — сейчас заданий сети у игрока нет.
   */
  async session(accountId: string, block: AdBlockRow, at: Date, admit: (history: PlaceHistory) => boolean): Promise<AdTaskOffer | null> {
    const outcome = await this.db(
      this.repository.openTask(accountId, block.networkKey, at, (history) =>
        admit(history)
          ? {
              sessionId: randomBytes(12).toString("base64url"),
              accountId,
              place: "task",
              block,
              creative: null,
              createdAt: at,
              expiresAt: new Date(at.getTime() + TASK_SESSION_TTL_MIN * MINUTE_MS),
            }
          : null,
      ),
    );
    if (outcome === null) return null;
    if (outcome.created) this.log({ event: "ad_offered", accountId, place: "task", network: block.networkKey, success: block.success });
    return this.offerOf(outcome.session, block);
  }

  /**
   * Сеть подтвердила задание игрока своей площадки. Нет игрока или открытой
   * сессии — награды нет: подтверждение без выдачи задания не выполняет
   * ничего, и подделать его можно только с секретом адреса.
   */
  async confirm(networkKey: string, platform: PlatformId, platformUserId: string, at: Date): Promise<TaskConfirmOutcome> {
    const account = await this.db(this.accounts.byPlatformUser(platform, platformUserId));
    if (account === null) {
      this.log({ event: "ad_task_unknown_player", network: networkKey });
      return "unknown_player";
    }
    const confirmed = await this.db(this.repository.confirmTask(account.accountId, networkKey, at));
    if (confirmed === null) {
      this.log({ event: "ad_task_unmatched", accountId: account.accountId, network: networkKey });
      return "unmatched";
    }
    const { session, repeat } = confirmed;
    if (!repeat) this.log({ event: "ad_completed", accountId: account.accountId, place: "task", network: networkKey });
    await this.hooks.emit({ accountId: account.accountId, networkKey, sessionId: session.sessionId, repeat, at });
    return "confirmed";
  }

  private offerOf(session: AdSessionRow, block: AdBlockRow): AdTaskOffer {
    return {
      sessionId: session.sessionId,
      network: block.networkKey,
      blockId: block.externalId,
      keys: block.networkKeys,
      debug: this.settings.get(SETTINGS.adsTestMode),
      expiresAt: new Date(session.createdAt.getTime() + TASK_SESSION_TTL_MIN * MINUTE_MS).toISOString(),
    };
  }

  private log(fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "ads", ...fields }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "задания сетей");
  }
}

/**
 * Сравнение секретов за постоянное время — и по длине тоже: сравниваются
 * хэши, так что по времени ответа не узнать ни знаков, ни длины.
 */
export function sameSecret(received: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}
