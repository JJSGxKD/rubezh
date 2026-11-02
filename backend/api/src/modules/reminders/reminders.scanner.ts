import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { gameDayOf } from "../tasks/task-pool.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Messengers } from "../../platforms/ports/messenger.js";
import { AccountSettingsService } from "../account-settings/account-settings.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { NotificationPayload } from "../notifications/notification-kinds.js";
import { RATED_DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { SEASON_BOARD_STORE, type SeasonBoardStore } from "../seasons/season-board.store.js";
import type { Season } from "../seasons/season-rules.js";
import { SeasonSchedule } from "../seasons/seasons-schedule.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import {
  chooseKind,
  closingDay,
  isQuietHour,
  overtaken,
  reminderDedupeKey,
  SCAN_INTERVAL_MS,
  SNAPSHOT_TOP,
  TICK_LIMIT,
  type CurrentPlace,
  type ReminderKind,
  type SnapshotEntry,
} from "./reminder-rules.js";
import { REMINDERS_REPOSITORY, type ReminderTarget, type RemindersRepository } from "./reminders.repository.js";
import { RemindersReport } from "./reminders.report.js";
import { CURSOR_DONE, RemindersStore } from "./reminders.store.js";

/**
 * Планировщик напоминаний бота (tasks/T-0128, docs/39-retention-mechanics.md П5).
 * Раз в `SCAN_INTERVAL_MS` ищет игроков, которым есть что напомнить, и пишет
 * им строку ленты — дальше работает дубль в бота (`notifications-bot`): очередь
 * под лимитером, потолок, тихие часы и выбор игрока проверяются ещё раз при
 * отправке.
 *
 * - **Один проход на все реплики**: лок в Redis с токеном (как `fx.refresher.ts`).
 * - **Страницами**: закрытие сезона и награда дня читаются с курсором по
 *   `account_id`, `TICK_LIMIT` за проход; курсор сдвигается после записи строк,
 *   поэтому упавший проход повторит страницу, а ключ события в ленте не даст
 *   второй строки.
 * - **Один вид на игрока в окно**: виды собираются на игрока за проход и
 *   выбираются по приоритету (`chooseKind`).
 * - **Тихий час и сбой — без снимка**: проход в тихие часы ничего не читает и
 *   снимок таблицы не двигает, поэтому обгон за ночь утром виден.
 */

/** Столько отказов подряд — база или Redis легли: проход бросается, курсор не двигается. */
const MAX_FAILURES_IN_ROW = 5;
/** Одновременных запросов `rank` при сравнении со снимком. */
const RANK_BATCH = 20;
const REMINDERS_KEY = "bot.reminders";

type TickStatus = "done" | "disabled" | "locked" | "quiet" | "no_season" | "failed";

export interface TickSummary {
  status: TickStatus;
  /** сколько игроков подошло под каждый вид, до выбора одного вида на игрока */
  candidates: Record<ReminderKind, number>;
  /** сколько строк ленты создано */
  created: Record<ReminderKind, number>;
  /** сколько игроков отброшено и почему */
  skipped: Record<string, number>;
}

/** Что напомнить: вид, данные и ключ события — согласованные друг с другом. */
type Reminder =
  | { kind: "season_overtaken"; payload: NotificationPayload<"season_overtaken">; dedupeKey: string }
  | { kind: "season_closing"; payload: NotificationPayload<"season_closing">; dedupeKey: string }
  | { kind: "daily_reward_ready"; payload: NotificationPayload<"daily_reward_ready">; dedupeKey: string };

interface Offer {
  target: ReminderTarget;
  reminders: Map<ReminderKind, Reminder>;
}

const zeroes = (): Record<ReminderKind, number> => ({ season_overtaken: 0, season_closing: 0, daily_reward_ready: 0 });

@Injectable()
export class RemindersScanner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("reminders");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(REMINDERS_REPOSITORY) private readonly repository: RemindersRepository,
    private readonly store: RemindersStore,
    private readonly schedule: SeasonSchedule,
    // Токены — явно: у `Pick` в метаданных типов остаётся `Object`, и Nest не нашёл бы, что внедрять.
    @Inject(SEASON_BOARD_STORE) private readonly board: Pick<SeasonBoardStore, "top" | "rank" | "scores">,
    @Inject(NotificationsService) private readonly notifications: Pick<NotificationsService, "notify">,
    @Inject(AccountSettingsService) private readonly accountSettings: Pick<AccountSettingsService, "valueOf">,
    private readonly messengers: Messengers,
    @Inject(RemindersReport) private readonly report: Pick<RemindersReport, "runIfDue">,
  ) {}

  /** Без входа игроков нет аккаунтов, а значит, и писать некому; включатель читается на каждом проходе. */
  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    this.timer = setInterval(() => void this.tick(), SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход. Не бросает: сбой — строка в логе, следующий проход продолжит с курсора. */
  async tick(now = new Date()): Promise<TickSummary> {
    const summary = this.empty("done");
    // Выключенный включатель не трогает ни Redis, ни базу: ключ по умолчанию выключен.
    if (!this.settings.get(SETTINGS.remindersEnabled)) return { ...summary, status: "disabled" };
    if (this.running) return { ...summary, status: "locked" };
    this.running = true;
    const token = randomUUID();
    let locked = false;
    try {
      locked = await this.store.acquireLock(token);
      if (!locked) return { ...summary, status: "locked" };
      // Отчёт за вчера идёт и в тихие часы: он нужен команде с 00:10, а тихо до 10:00.
      await this.report.runIfDue(now).catch((error: unknown) => this.warn("report_failed", error));
      if (isQuietHour(now, this.settings.get(SETTINGS.remindersQuietFromHour), this.settings.get(SETTINGS.remindersQuietToHour))) return { ...summary, status: "quiet" };
      const season = this.schedule.current(now);
      if (season === null) return { ...summary, status: "no_season" };
      await this.scan(season, now, summary);
      this.logger.log(JSON.stringify({ module: "reminders", event: "reminders_tick", candidates: summary.candidates, created: summary.created, skipped: summary.skipped }));
      return summary;
    } catch (error: unknown) {
      this.warn("tick_failed", error);
      return { ...summary, status: "failed" };
    } finally {
      if (locked) await this.store.releaseLock(token).catch((error: unknown) => this.warn("unlock_failed", error));
      this.running = false;
    }
  }

  private empty(status: TickStatus): TickSummary {
    return { status, candidates: zeroes(), created: zeroes(), skipped: {} };
  }

  private async scan(season: Season, now: Date, summary: TickSummary): Promise<void> {
    const day = gameDayOf(now);
    const offers = new Map<string, Offer>();
    const offer = (target: ReminderTarget, reminder: Reminder): void => {
      const known = offers.get(target.accountId);
      if (known === undefined) offers.set(target.accountId, { target, reminders: new Map([[reminder.kind, reminder]]) });
      else known.reminders.set(reminder.kind, reminder);
      summary.candidates[reminder.kind]++;
    };
    // Курсоры и снимки пишутся после записи строк: упавший проход повторит страницу.
    const cursors: { name: string; value: string }[] = [];
    const snapshots: { difficulty: Difficulty; entries: SnapshotEntry[] }[] = [];

    for (const difficulty of RATED_DIFFICULTIES) snapshots.push(await this.overtakenOffers(season, day, difficulty, offer));

    if (day === closingDay(season)) {
      const name = `closing:${season.key}`;
      const cursor = await this.store.readCursor(name);
      if (cursor !== CURSOR_DONE) {
        const since = this.schedule.ratingSince();
        const from = since !== null && since.getTime() > season.startsAt.getTime() ? since : season.startsAt;
        const page = await this.repository.closingPage({ from, to: season.endsAt }, cursor, TICK_LIMIT);
        for (const target of page) offer(target, { kind: "season_closing", payload: { endsAt: season.endsAt.toISOString() }, dedupeKey: reminderDedupeKey.seasonClosing(season.key) });
        cursors.push({ name, value: nextCursor(page) });
      }
    }

    const dailyName = `daily:${day}`;
    const dailyCursor = await this.store.readCursor(dailyName);
    if (dailyCursor !== CURSOR_DONE) {
      const page = await this.repository.dailyPage({ today: day, lapseDays: this.settings.get(SETTINGS.remindersLapseDays) }, dailyCursor, TICK_LIMIT);
      for (const target of page) offer(target, { kind: "daily_reward_ready", payload: {}, dedupeKey: reminderDedupeKey.dailyRewardReady(day) });
      cursors.push({ name: dailyName, value: nextCursor(page) });
    }

    await this.resolve(offers, now, summary);
    for (const cursor of cursors) await this.store.writeCursor(cursor.name, cursor.value);
    for (const snapshot of snapshots) await this.store.writeSnapshot(season.key, snapshot.difficulty, snapshot.entries);
  }

  /**
   * Сравнить таблицу недели со снимком прошлого прохода и предложить «обогнали»
   * тем, кого обошли. Возвращает новый снимок — его пишет вызывающий, когда
   * строки уже записаны.
   */
  private async overtakenOffers(season: Season, day: string, difficulty: Difficulty, offer: (target: ReminderTarget, reminder: Reminder) => void): Promise<{ difficulty: Difficulty; entries: SnapshotEntry[] }> {
    const top = await this.board.top(season.key, difficulty, SNAPSHOT_TOP);
    const entries = top.map((entry, index) => ({ accountId: entry.accountId, rank: index + 1, score: entry.survivalSec }));
    const before = await this.store.readSnapshot(season.key, difficulty);
    if (before === null) return { difficulty, entries };
    const hits = overtaken(before, await this.currentPlaces(season.key, difficulty, before));
    if (hits.length === 0) return { difficulty, entries };
    const places = new Map(hits.map((hit) => [hit.accountId, hit.place]));
    for (const target of await this.repository.reachable(hits.map((hit) => hit.accountId))) {
      const place = places.get(target.accountId);
      if (place === undefined) continue;
      offer(target, { kind: "season_overtaken", payload: { difficulty, place }, dedupeKey: reminderDedupeKey.seasonOvertaken(season.key, day) });
    }
    return { difficulty, entries };
  }

  /** Где сейчас те, кто был в снимке: результат одним конвейером, места — пачками по `RANK_BATCH`. */
  private async currentPlaces(seasonKey: string, difficulty: Difficulty, before: readonly SnapshotEntry[]): Promise<Map<string, CurrentPlace>> {
    const scores = await this.board.scores(seasonKey, difficulty, before.map((entry) => entry.accountId));
    const places = new Map<string, CurrentPlace>();
    const ids = [...scores.keys()];
    for (let start = 0; start < ids.length; start += RANK_BATCH) {
      const batch = ids.slice(start, start + RANK_BATCH);
      const ranks = await Promise.all(batch.map(async (accountId) => await this.board.rank(seasonKey, difficulty, accountId)));
      batch.forEach((accountId, index) => {
        const rank = ranks[index];
        const score = scores.get(accountId);
        if (rank !== null && rank !== undefined && score !== undefined) places.set(accountId, { rank, score });
      });
    }
    return places;
  }

  /** По одному виду на игрока: бота нет, окно занято, игрок отписался — отбрасываем, остальным пишем строку. */
  private async resolve(offers: ReadonlyMap<string, Offer>, now: Date, summary: TickSummary): Promise<void> {
    const busy = await this.store.busyWindows([...offers.keys()]);
    let failures = 0;
    for (const [accountId, offer] of offers) {
      try {
        const reason = await this.remind(accountId, offer, busy.has(accountId), now, summary);
        if (reason !== null) summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
        failures = 0;
      } catch (error: unknown) {
        // Один игрок с бедой не стоит прохода, а лежащая база стоит: подряд — бросаем.
        failures++;
        summary.skipped.error = (summary.skipped.error ?? 0) + 1;
        this.warn("account_failed", error);
        if (failures >= MAX_FAILURES_IN_ROW) throw error;
      }
    }
  }

  /** `null` — строка ленты записана; иначе причина, по которой игроку не пишем. */
  private async remind(accountId: string, offer: Offer, windowBusy: boolean, now: Date, summary: TickSummary): Promise<string | null> {
    if (this.messengers.for(offer.target.platform) === null) return "no_bot";
    if (windowBusy) return "window_busy";
    const optedOut = (await this.accountSettings.valueOf(accountId, REMINDERS_KEY)) === false;
    const kind = chooseKind({ kinds: [...offer.reminders.keys()], canMessage: true, optedOut, windowBusy });
    const reminder = kind === null ? undefined : offer.reminders.get(kind);
    if (reminder === undefined) return "opted_out";
    const written = await this.write(accountId, reminder, now);
    if (!written) return "not_written";
    summary.created[reminder.kind]++;
    return null;
  }

  private async write(accountId: string, reminder: Reminder, at: Date): Promise<boolean> {
    switch (reminder.kind) {
      case "season_overtaken":
        return await this.notifications.notify({ accountId, kind: reminder.kind, payload: reminder.payload, dedupeKey: reminder.dedupeKey, at });
      case "season_closing":
        return await this.notifications.notify({ accountId, kind: reminder.kind, payload: reminder.payload, dedupeKey: reminder.dedupeKey, at });
      case "daily_reward_ready":
        return await this.notifications.notify({ accountId, kind: reminder.kind, payload: reminder.payload, dedupeKey: reminder.dedupeKey, at });
    }
  }

  private warn(event: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "reminders", event, reason: error instanceof Error ? error.message : "unknown" }));
  }
}

/** Страница меньше лимита — последняя: курсор «готово»; иначе — последний игрок страницы. */
function nextCursor(page: readonly ReminderTarget[]): string {
  const last = page[page.length - 1];
  return page.length < TICK_LIMIT || last === undefined ? CURSOR_DONE : last.accountId;
}
