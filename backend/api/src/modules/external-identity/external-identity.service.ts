import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { ExternalLinkStarters } from "../../platforms/ports/external-link.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { EVENT_DICTIONARY } from "../events/event-dictionary.js";
import type { EventRow } from "../events/events.repository.js";
import { EVENTS_SINK, type EventsSink } from "../events/events.sink.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { AccountRef } from "../roles/roles.service.js";
import { LinkUnavailableError } from "./external-identity-errors.js";
import {
  LINK_CODE_PATTERN,
  LINK_CODE_TTL_SEC,
  LINK_START_LIMIT,
  isLinkPlatform,
  newLinkCode,
  type ConsumeOutcome,
  type LinkOutcome,
  type LinkPlatform,
} from "./external-identity-rules.js";
import { EXTERNAL_IDENTITY_REPOSITORY, type ExternalIdentityRepository } from "./external-identity.repository.js";
import { LINK_CODE_STORE, type LinkCodeStore } from "./link-codes.js";

/**
 * Связь игрового аккаунта с аккаунтом MAX или VK (docs/35-stage4-plan.md Р188,
 * tasks/T-0377). Чтобы проверить подписку на канал другой площадки, сервер
 * должен знать, кто этот игрок там:
 *
 * 1. игрок просит ссылку на бота площадки (`startLink`) — в ней одноразовый
 *    код на 30 минут;
 * 2. бот получает код вместе с id игрока и отдаёт их серверу (`consume`);
 * 3. задания спрашивают id площадки у `externalId`.
 *
 * Связь служит заданиям, а не входу, и постоянна: один id площадки — один
 * игровой аккаунт, у аккаунта на площадке одна связь, перепривязка — только
 * через поддержку. Боты площадок — отдельные задачи (T-0378, T-0379): здесь
 * только то, что они вызывают.
 */

const DB_TIMEOUT_MS = 3_000;
const EVENT_TIMEOUT_MS = 2_000;
/** Сколько раз пробовать другой код, если выпавший уже занят: на деле хватает одной попытки. */
const CODE_ATTEMPTS = 3;
/** id игрока на площадке, как его присылает бот: до 64 знаков (столбец), без пробелов и управляющих. */
const EXTERNAL_USER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** Конверт серверного события: у сервера нет устройства (как у `run_scored`). */
const SERVER_INSTALL_ID = "server";

@Injectable()
export class ExternalIdentityService {
  private readonly logger = new Logger("external-identity");
  /** Часы подменяются в тестах: окно лимита и время события. */
  clock: () => number = () => Date.now();

  constructor(
    @Inject(EXTERNAL_IDENTITY_REPOSITORY) private readonly repository: ExternalIdentityRepository,
    @Inject(LINK_CODE_STORE) private readonly codes: LinkCodeStore,
    private readonly starters: ExternalLinkStarters,
    private readonly limiter: RateLimiter,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    @Optional() @Inject(EVENTS_SINK) private readonly sink: EventsSink | null = null,
  ) {}

  /**
   * Ссылка на бота площадки с новым кодом. Связь уже есть — ссылка всё равно
   * выдаётся: бот ответит «уже связано» и даст канал.
   */
  async startLink(account: AccountRef, platform: PlatformId): Promise<{ url: string }> {
    if (platform === account.platform) throw new ValidationError("Эта площадка у тебя основная — связывать её не нужно");
    if (!isLinkPlatform(platform)) throw new ValidationError("С этой площадкой аккаунт не связывается");
    const target = { accountId: account.accountId, platform };
    const urlFor = (code: string): string => this.starters.for(platform)?.startUrl(code) ?? failUnavailable();

    let code = newLinkCode();
    let url = urlFor(code);
    // Лимит — после проверки площадки: пока бот не настроен, нажатия не должны расходовать часовой запас.
    if (!(await this.limiter.consume(LINK_START_LIMIT, account.accountId, 1, this.clock()))) throw new RateLimitedError("Слишком часто — попробуй позже");
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      if (await this.putCode(code, target)) return { url };
      code = newLinkCode();
      url = urlFor(code);
    }
    this.logger.error(JSON.stringify({ module: "external-identity", event: "code_collision", platform }));
    throw new LinkUnavailableError();
  }

  /**
   * Бот площадки отдаёт код и id игрока. Код забирается атомарно: два бота не
   * применят один код дважды. Неверный, чужой площадки и протухший код, как и
   * аккаунт, которого больше нет, — `expired`; код другой площадки сгорает
   * тоже, настоящий бот его не пришлёт.
   *
   * @throws ValidationError id игрока не похож на id площадки — ошибка бота, а не игрока
   */
  async consume(platform: PlatformId, code: string, externalUserId: string): Promise<ConsumeOutcome> {
    if (!EXTERNAL_USER_ID.test(externalUserId)) throw new ValidationError("Неверный id игрока на площадке");
    if (!isLinkPlatform(platform) || !LINK_CODE_PATTERN.test(code)) return "expired";
    const target = await this.codes.take(code);
    if (target === null || target.platform !== platform) return "expired";
    const account = await this.db(this.accounts.byId(target.accountId));
    if (account === null) return "expired";
    const result = await this.db(this.repository.link(target.accountId, platform, externalUserId));
    if (result === "missing") return "expired";
    // Метрика `external_link_total{platform,result}` — строкой лога, пока в бэкенде нет Prometheus (docs/22 §3.3).
    this.logger.log(JSON.stringify({ module: "external-identity", event: "external_link", accountId: target.accountId, platform, result }));
    await this.announce({ platform: account.platform, platformUserId: account.platformUserId }, platform, result);
    return result;
  }

  /** id игрока на площадке или `null`, если аккаунт ещё не связан. */
  async externalId(accountId: string, platform: PlatformId): Promise<string | null> {
    const row = await this.db(this.repository.find(accountId, platform));
    return row?.externalUserId ?? null;
  }

  private async putCode(code: string, target: { accountId: string; platform: LinkPlatform }): Promise<boolean> {
    try {
      return await this.codes.put(code, target, LINK_CODE_TTL_SEC);
    } catch (error: unknown) {
      // Redis недоступен — кода негде хранить, а значит и бота открывать рано.
      this.logger.warn(JSON.stringify({ module: "external-identity", event: "code_store_failed", reason: error instanceof Error ? error.message : String(error) }));
      throw new LinkUnavailableError();
    }
  }

  /**
   * Серверное событие `external_account_linked` (docs/22-analytics-and-metrics.md §3.3).
   * Падение писателя связи не мешает: событие — аналитика, а не запись. Id игрока на
   * площадке в событии нет — игрок виден по своей площадке и своему id.
   */
  private async announce(player: { platform: PlatformId; platformUserId: string }, platform: LinkPlatform, result: LinkOutcome): Promise<void> {
    if (this.sink === null) return;
    try {
      const payload = EVENT_DICTIONARY.external_account_linked.payload.parse({ platform, result });
      const at = new Date(this.clock()).toISOString();
      const row: EventRow = {
        eventId: randomUUID(),
        eventType: "external_account_linked",
        schemaVersion: EVENT_DICTIONARY.external_account_linked.version,
        installId: SERVER_INSTALL_ID,
        platformUserId: player.platformUserId,
        sessionId: randomUUID(),
        platform: player.platform,
        appVersion: "server",
        payload,
        occurredAt: at,
        receivedAt: at,
      };
      await withTimeout(this.sink.write([row]), EVENT_TIMEOUT_MS, "событие связи аккаунтов");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "external-identity", event: "event_failed", reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "связь аккаунтов");
  }
}

function failUnavailable(): never {
  throw new LinkUnavailableError();
}
