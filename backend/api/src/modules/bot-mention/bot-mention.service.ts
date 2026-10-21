import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { BotMentions, type BotMention, type MentionKind, type MentionOutcome } from "../../platforms/ports/bot-mention.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { gameDayOf } from "../tasks/task-pool.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { WalletService } from "../wallet/wallet.service.js";
import { BotMentionBackoff } from "./bot-mention-backoff.js";
import { BotMentionUnavailableForPlatformError, TaskNotOfferedError } from "./bot-mention-errors.js";
import { activeStreak, canCheckUserId, noReward, offeredKinds, rewardOf, type BotMentionKind, type BotMentionResult, type BotMentionReward, type BotMentionRow } from "./bot-mention-rules.js";
import { BOT_MENTION_REPOSITORY, type BotMentionRepository } from "./bot-mention.repository.js";

/**
 * Задания «юзернейм бота» (docs/35-stage4-plan.md Р110, tasks/T-0162): игрок
 * вписывает юзернейм бота игры в имя и, отдельно, в bio, а сервер проверяет и
 * платит за игровые сутки. Площадку домен знает только через порт
 * `BotMentions`. Текст имени и bio наружу из порта не выходит, поэтому его
 * нет ни в базе, ни в ответах, ни в логе.
 *
 * Награда начисляется сразу, без «забрать»: ночной проход идёт, когда игрока в
 * игре нет, а невзятая награда сгорала бы со сменой суток. Сначала кошелёк
 * (по ключу с датой — повтор ничего не доплатит), потом отметка суток
 * (`rewardDay` — один `UPDATE`): сбой между ними лечится повторной проверкой.
 */

const DB_TIMEOUT_MS = 5_000;
/** Площадка не ответила за это время — проверка считается неудавшейся, а не вечной. */
const PORT_TIMEOUT_MS = 15_000;
/** Сбой связи с площадкой, о сроке которого она не сказала. */
const PORT_FAILURE_RETRY_SEC = 5;

/** Ресурс награды в кошельке: осколки заданий — обычные. */
const REWARD_RESOURCES = [
  ["coins", "coins"],
  ["gems", "gems"],
  ["shards", "shard_common"],
] as const satisfies readonly (readonly [keyof BotMentionReward, WalletResource])[];

export interface BotMentionTaskView {
  kind: BotMentionKind;
  reward: BotMentionReward;
  started: boolean;
  /** серия на сегодня (`activeStreak`) */
  streak: number;
  bestStreak: number;
  rewardedToday: boolean;
  lastResult: BotMentionResult | null;
  checkedAt: string | null;
}

export interface BotMentionView {
  /** что вписать, без «@»; `null` — у этой площадки заданий нет */
  botUsername: string | null;
  /** только показываемые: функция включена, награда вида больше нуля */
  tasks: BotMentionTaskView[];
}

export type BotMentionOutcome = BotMentionResult | "retry" | "done_today";

export interface BotMentionCheck {
  outcome: BotMentionOutcome;
  /** сколько легло сейчас; нули — не начислялось */
  credited: BotMentionReward;
  view: BotMentionView;
}

/** Итог одной проверки вида: исход и то, что легло на баланс. */
export interface BotMentionSettled {
  outcome: BotMentionResult | "done_today";
  credited: BotMentionReward;
}

@Injectable()
export class BotMentionService {
  private readonly logger = new Logger("bot-mention");

  constructor(
    @Inject(BOT_MENTION_REPOSITORY) private readonly repository: BotMentionRepository,
    private readonly mentions: BotMentions,
    private readonly wallet: WalletService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly backoff: BotMentionBackoff,
  ) {}

  async view(account: AccountRef, at = new Date()): Promise<BotMentionView> {
    const port = this.mentions.for(account.platform);
    if (port === null) return { botUsername: null, tasks: [] };
    const kinds = offeredKinds(this.settings);
    if (kinds.length === 0) return { botUsername: port.botUsername(), tasks: [] };
    const rows = await this.db(this.repository.rows(account.accountId));
    const today = gameDayOf(at);
    return { botUsername: port.botUsername(), tasks: kinds.map((kind) => this.taskView(kind, rows.find((row) => row.kind === kind) ?? null, today)) };
  }

  /**
   * Ручная проверка («Проверить»): вписал юзернейм днём — не ждёт ночного
   * прохода. Награждённые сутки площадку не спрашивают; пока площадка просила
   * подождать — тоже. Первая проверка начинает задание.
   */
  async check(account: AccountRef, kind: BotMentionKind, at = new Date()): Promise<BotMentionCheck> {
    const port = this.mentions.for(account.platform);
    if (port === null) throw new BotMentionUnavailableForPlatformError();
    if (!offeredKinds(this.settings).includes(kind)) throw new TaskNotOfferedError();

    const day = gameDayOf(at);
    await this.db(this.repository.ensure(account.accountId, kind, at));
    const row = (await this.db(this.repository.rows(account.accountId))).find((candidate) => candidate.kind === kind);
    if (row?.lastDay === day) return await this.answer(account, "done_today", noReward(), at);
    if ((await this.backoff.remainingMs()) > 0) return await this.answer(account, "retry", noReward(), at);

    if (!canCheckUserId(account.platformUserId)) {
      const settled = await this.settle(account.accountId, kind, "unavailable", day, at);
      return await this.answer(account, settled.outcome, settled.credited, at);
    }
    const outcome = await this.ask(port, account.platformUserId, [kind]);
    if (outcome.status === "retry") {
      await this.pauseFor(outcome.afterSec);
      return await this.answer(account, "retry", noReward(), at);
    }
    const finding = outcome.status === "checked" ? (outcome.findings[kind] ?? "unavailable") : "unavailable";
    const settled = await this.settle(account.accountId, kind, finding, day, at);
    return await this.answer(account, settled.outcome, settled.credited, at);
  }

  /**
   * Итог проверки вида за игровые сутки `day`. `present` — награда кошельком и
   * отметка суток; остальное — только отметка проверки: убравший юзернейм
   * не теряет полученного и штрафа не получает, награды за сутки просто нет.
   */
  async settle(accountId: string, kind: BotMentionKind, finding: BotMentionResult, day: string, at: Date): Promise<BotMentionSettled> {
    if (finding !== "present") {
      await this.db(this.repository.markChecked(accountId, kind, day, finding, at));
      return { outcome: finding, credited: noReward() };
    }
    const reward = rewardOf(kind, this.settings);
    const credited = noReward();
    for (const [field, resource] of REWARD_RESOURCES) {
      if (reward[field] <= 0) continue;
      const result = await this.db(
        this.wallet.grant({
          accountId,
          resource,
          amount: reward[field],
          reason: "task_reward",
          source: `bot-mention:${kind}`,
          idempotencyKey: `bot-mention:${accountId}:${kind}:${day}:${resource}`,
          at,
        }),
      );
      credited[field] = result.credited;
    }
    const rewarded = await this.db(this.repository.rewardDay(accountId, kind, day, at));
    // Сутки успел засчитать другой вызов: награда одна, и рассказывает о ней он.
    if (rewarded === null) return { outcome: "done_today", credited: noReward() };
    this.logger.log(JSON.stringify({ module: "bot-mention", event: "bot_mention_day_rewarded", accountId, kind, streak: rewarded.streak }));
    return { outcome: "present", credited };
  }

  /**
   * Вопрос площадке с потолком по времени. Исключение порта — это не «ответ»:
   * считается сбоем связи, `retry` на несколько секунд. Текст ошибки может
   * нести имя игрока, поэтому в лог идёт только её имя.
   */
  async ask(port: BotMention, platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome> {
    try {
      return await withTimeout(port.check(platformUserId, kinds), PORT_TIMEOUT_MS, "bot-mention: площадка");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "bot-mention", event: "bot_mention_port_failed", platform: port.platform, reason: error instanceof Error ? error.name : "unknown" }));
      return { status: "retry", afterSec: PORT_FAILURE_RETRY_SEC };
    }
  }

  /** Площадка попросила подождать: ни проход, ни ручная проверка не ходят к ней, пока пауза жива. */
  async pauseFor(afterSec: number): Promise<void> {
    await this.backoff.hold(afterSec);
    this.logger.warn(JSON.stringify({ module: "bot-mention", event: "bot_mention_paused", afterSec }));
  }

  private taskView(kind: BotMentionKind, row: BotMentionRow | null, today: string): BotMentionTaskView {
    return {
      kind,
      reward: rewardOf(kind, this.settings),
      started: row !== null,
      streak: row === null ? 0 : activeStreak(row, today),
      bestStreak: row?.bestStreak ?? 0,
      rewardedToday: row?.lastDay === today,
      lastResult: row?.lastResult ?? null,
      checkedAt: row?.checkedAt?.toISOString() ?? null,
    };
  }

  private async answer(account: AccountRef, outcome: BotMentionOutcome, credited: BotMentionReward, at: Date): Promise<BotMentionCheck> {
    return { outcome, credited, view: await this.view(account, at) };
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "bot-mention");
  }
}
