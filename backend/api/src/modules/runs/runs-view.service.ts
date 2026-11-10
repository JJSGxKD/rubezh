import { Inject, Injectable, Optional } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { LEADERBOARD_STORE, type Board, type LeaderboardStore } from "./leaderboard.store.js";
import { PrologueService } from "./prologue.service.js";
import { RatingRestrictions } from "./rating-restrictions.js";
import { RunExtras, type RunLootPart, type RunRewardPart } from "./run-details.js";
import { RunPrestige } from "./run-prestige.js";
import { DIFFICULTIES, isRatedDifficulty, type Difficulty } from "./run-rules.js";
import { RUNS_REPOSITORY, type ReviewRow, type RunDetailRow, type RunsRepository } from "./runs.repository.js";

/**
 * Чтение забегов (docs/34-stage3-plan.md, WP4): лидерборд, профиль, очередь
 * разбора. Форма ответов повторяет плейтестовую — клиент переедет на модуль,
 * не переписывая экраны.
 *
 * Игрок под молчаливым ограничением рейтинга (docs/35-stage4-plan.md WP44,
 * О40) видит доску и профиль из тени: себя — на месте, которое занял бы
 * лучшим забегом, остальных — как есть. Другие его не видят: в доске его нет.
 *
 * Читается доска смотрящего (Р104, T-0113): аккаунт со скрытым ограничением
 * «Отдельная доска» читает полную, остальные — общую. Место, «всего
 * игроков», профиль и размер доски считаются по ней; форма ответов у всех
 * одна, поля «доска» нет. Каждый метод узнаёт доску один раз в начале.
 *
 * Доски ранжируют по очкам эффективности лучшего забега (tasks/T-0294, Р66):
 * `points` — главное число строки, `survivalSec` — время того же забега,
 * подпись; `style` — стиль забега (T-0293). Старые клиенты читают прежнее поле
 * времени, пока экран не переедет на очки (T-0296).
 *
 * Единая сложность (Р126, T-0191): доски, лучшее и размер доски есть только у
 * рейтинговых сложностей; у остальных форма ответа та же, но пустая — `null`,
 * `0`, пустой список, — и ни Redis, ни база для них не читаются. Старый клиент
 * по-прежнему просит `easy` и `normal` и получает пустую доску, а не ошибку.
 */

export const LEADERBOARD_LIMIT = 50;
const RECENT_RUNS_SHOWN = 10;
/** Сколько лучших забегов сложности видит модератор — тех, что держат игрока в доске. */
const MODERATION_RUNS_SHOWN = 10;

/** Забег в карточке игрока для модератора — рейтинговый или снятый им с рейтинга. */
export interface ModerationRunView {
  runId: string;
  survivalSec: number;
  /** очки эффективности; `null` — очков нет */
  points: number | null;
  level: number;
  enemiesKilled: number;
  startingWeaponId: string;
  finishedAt: string;
  ranked: boolean;
}

export interface LeaderboardView {
  difficultyId: Difficulty;
  entries: {
    rank: number;
    /** лучший забег игрока: по нему открывается карточка забега (T-0297) */
    runId?: string;
    name: string;
    photoUrl: string | null;
    /** знак «Тестер» (Р87); поля нет — не тестер */
    tester?: true;
    /** знак «Меценат» (Р109); поля нет — не поддержал */
    supporter?: true;
    /** очки эффективности лучшего забега — по ним ранжируется доска */
    points: number;
    /** время того же забега — подпись к очкам */
    survivalSec: number;
    /** стиль забега (T-0293) */
    style: string | null;
    level: number;
    startingWeaponId: string;
    enemiesKilled: number;
    isMe: boolean;
    /** очки престижа за достижения (tasks/T-0107); ноль — значок не рисуется */
    prestige: number;
    /** отметка рубежа (T-0121): у аккаунта засчитана победа над стражем; поля нет — не засчитана */
    rubezh?: true;
  }[];
  me: { rank: number; points: number; survivalSec: number; style: string | null } | null;
  totalPlayers: number;
}

/** Лучший забег игрока на доске: очки, их место, время и стиль того же забега. */
export interface BestView {
  points: number;
  survivalSec: number;
  style: string | null;
  rank: number;
}

export interface ProfileView {
  runs: number;
  totalKills: number;
  totalSurvivalSec: number;
  best: Record<Difficulty, BestView | null>;
  recent: { runId: string; difficultyId: Difficulty; survivalSec: number; level: number; startingWeaponId: string; at: number }[];
  /** пролог пройден (T-0279): `false` — «Награда дня» и «Задания» закрыты, следующий запуск снова пролог; у аккаунтов до пролога — `true` */
  prologueDone: boolean;
}

/**
 * Лист забега в профиле. Числа, которых сборка игрока не прислала, — `null`:
 * лист показывает то, что знает, а не нули вместо неизвестного.
 */
export interface RunDetailView {
  runId: string;
  difficultyId: Difficulty;
  startingWeaponId: string;
  at: number;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  /** враг, нанёсший смертельный удар; `null` — сдался или неизвестно */
  deathCause: string | null;
  weapons: { id: string; level: number; damage: number | null }[];
  passives: { id: string; level: number }[];
  damageTaken: number | null;
  xpCollected: number | null;
  waveReached: number | null;
  topKills: { enemy: string; count: number }[];
  /** сколько раз продолжал после смерти */
  continues: number;
  /**
   * Рейтинг словами, без кодов антифрода: `ranked` — учтён; `cheats` —
   * с читами разработчика; `review` — не учтён после проверки;
   * `restricted` — не учтён: рейтинг игроку закрыт ограничением, о котором
   * ему сообщили. Под молчаливым — `ranked`: так игрок видит его из тени.
   */
  rating: "ranked" | "cheats" | "review" | "restricted";
  /** очки эффективности; `null` — очков нет, и карточки забега тоже (T-0297) */
  points: number | null;
  boosts: string[];
  reward: RunRewardPart | null;
  loot: RunLootPart[];
}

export class RunNotFoundError extends DomainError {
  constructor() {
    super("run_not_found", "Забег не найден", 404);
  }
}

@Injectable()
export class RunsViewService {
  constructor(
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    private readonly extras: RunExtras,
    private readonly rating: RatingRestrictions,
    private readonly prestige: RunPrestige,
    // Нет сервиса пролога (старый состав модуля) — разделы открыты.
    @Optional() private readonly prologue?: PrologueService,
  ) {}

  async leaderboardFor(accountId: string, difficulty: Difficulty): Promise<LeaderboardView> {
    if (!isRatedDifficulty(difficulty)) return { difficultyId: difficulty, entries: [], me: null, totalPlayers: 0 };
    const board = await this.rating.boardOf(accountId);
    const [top, total, rank, best, hold] = await Promise.all([
      this.leaderboard.top(difficulty, LEADERBOARD_LIMIT, board),
      this.leaderboard.count(difficulty, board),
      this.leaderboard.rank(difficulty, accountId, board),
      this.leaderboard.best(difficulty, accountId, board),
      this.rating.hold(accountId),
    ]);

    // Порядок и места — из проекции, подробности лучшего забега — из базы
    // одним запросом на всю страницу, престиж — одним запросом к достижениям:
    // игрок в тени добавляет в него себя, его строку рисует `fromShadow`.
    const ids = top.map((entry) => entry.accountId);
    // Свой забег подписи (время, стиль) берётся тем же запросом, если игрока нет в первой странице.
    const withMe = rank !== null && !ids.includes(accountId) ? [...ids, accountId] : ids;
    const [rows, prestige] = await Promise.all([this.runs.bestRuns(withMe, difficulty, this.rating.since()), this.prestige.of(hold === "silent" && !ids.includes(accountId) ? [...ids, accountId] : ids)]);
    const details = new Map(rows.map((row) => [row.accountId, row]));

    const view: LeaderboardView = {
      difficultyId: difficulty,
      // Идентификаторы чужих аккаунтов наружу не уходят: строка знает только,
      // «моя» ли она.
      entries: top.flatMap((entry, index) => {
        const row = details.get(entry.accountId);
        // Проекция и база разошлись — например, аккаунт удалён. Такую строку
        // не показываем, а не рисуем пустую: пересборка всё выровняет.
        if (row === undefined) return [];
        return [
          {
            rank: index + 1,
            ...(row.runId === undefined ? {} : { runId: row.runId }),
            name: row.displayName,
            photoUrl: row.photoUrl,
            ...(row.tester ? { tester: true as const } : {}),
            ...(row.supporter ? { supporter: true as const } : {}),
            points: entry.score,
            survivalSec: row.survivalSec,
            style: row.style,
            level: row.level,
            startingWeaponId: row.startingWeaponId,
            enemiesKilled: row.enemiesKilled,
            isMe: entry.accountId === accountId,
            prestige: prestige.get(entry.accountId) ?? 0,
            ...(entry.rubezh === true ? { rubezh: true as const } : {}),
          },
        ];
      }),
      me: rank === null || best === null ? null : { rank, points: best, survivalSec: details.get(accountId)?.survivalSec ?? 0, style: details.get(accountId)?.style ?? null },
      totalPlayers: total,
    };
    return hold === "silent" ? await this.fromShadow(accountId, difficulty, view, board, prestige.get(accountId) ?? 0) : view;
  }

  /**
   * Доска глазами игрока в тени: он — на месте, которое занял бы лучшим
   * забегом, включая сданные в тени, а те, кто ниже, сдвинуты на строку.
   */
  private async fromShadow(accountId: string, difficulty: Difficulty, view: LeaderboardView, board: Board, ownPrestige: number): Promise<LeaderboardView> {
    const mine = await this.runs.bestRunOf(accountId, difficulty, true, this.rating.since());
    // До обхода игрок мог остаться в доске гонкой с наложением — себя он видит один раз.
    const others = view.entries.filter((entry) => !entry.isMe);
    const players = view.totalPlayers - (view.me === null ? 0 : 1);
    if (mine === null || mine.points === null) return { ...view, entries: others, me: null, totalPlayers: players };

    const rank = (await this.leaderboard.countAbove(difficulty, mine.points, board)) + 1;
    const own = {
      rank,
      ...(mine.runId === undefined ? {} : { runId: mine.runId }),
      name: mine.displayName,
      photoUrl: mine.photoUrl,
      ...(mine.tester ? { tester: true as const } : {}),
      ...(mine.supporter ? { supporter: true as const } : {}),
      points: mine.points,
      survivalSec: mine.survivalSec,
      style: mine.style,
      level: mine.level,
      startingWeaponId: mine.startingWeaponId,
      enemiesKilled: mine.enemiesKilled,
      isMe: true,
      prestige: ownPrestige,
    };
    const entries = [...others.map((entry) => (entry.rank >= rank ? { ...entry, rank: entry.rank + 1 } : entry)), own]
      .filter((entry) => entry.rank <= LEADERBOARD_LIMIT)
      .sort((left, right) => left.rank - right.rank);
    return { ...view, entries, me: { rank, points: mine.points, survivalSec: mine.survivalSec, style: mine.style }, totalPlayers: players + 1 };
  }

  /**
   * `team` — карточка игрока в панели: команда видит правду, и в тени игрок
   * у неё без места в рейтинге.
   */
  async profile(accountId: string, audience: "player" | "team" = "player"): Promise<ProfileView> {
    // Для команды место такое же, как у владельца профиля: по доске аккаунта.
    const board = await this.rating.boardOf(accountId);
    const shadow = audience === "player" && (await this.rating.hold(accountId)) === "silent";
    const [prologueDone, stats, recent, ...bests] = await Promise.all([
      this.prologue === undefined ? true : this.prologue.isDone(accountId),
      this.runs.stats(accountId),
      this.runs.recent(accountId, RECENT_RUNS_SHOWN),
      ...DIFFICULTIES.map(async (difficulty) => (shadow ? await this.shadowBest(accountId, difficulty, board) : await this.boardBest(accountId, difficulty, board))),
    ]);

    return {
      ...stats,
      prologueDone,
      best: { easy: bests[0] ?? null, normal: bests[1] ?? null, hard: bests[2] ?? null },
      recent: recent.map((run) => ({
        runId: run.runId,
        difficultyId: run.difficulty,
        survivalSec: run.survivalSec,
        level: run.level,
        startingWeaponId: run.startingWeaponId,
        at: run.finishedAt.getTime(),
      })),
    };
  }

  /** Сколько игроков в доске глазами игрока: в тени он видит в ней и себя. */
  async boardSize(accountId: string, difficulty: Difficulty): Promise<number> {
    if (!isRatedDifficulty(difficulty)) return 0;
    const board = await this.rating.boardOf(accountId);
    const [total, hold] = await Promise.all([this.leaderboard.count(difficulty, board), this.rating.hold(accountId)]);
    if (hold !== "silent" || (await this.leaderboard.best(difficulty, accountId, board)) !== null) return total;
    return (await this.runs.bestRunOf(accountId, difficulty, true, this.rating.since())) === null ? total : total + 1;
  }

  /** Лучшие рейтинговые и снятые модератором забеги по сложностям — для карточки игрока в панели. */
  async moderationRuns(accountId: string): Promise<Record<Difficulty, ModerationRunView[]>> {
    // Нерейтингового забега модератор не снимает и не возвращает: списки easy и normal пусты, форма ответа прежняя.
    const since = this.rating.since();
    const lists = await Promise.all(DIFFICULTIES.map(async (difficulty) => (isRatedDifficulty(difficulty) ? await this.runs.moderationRuns(accountId, difficulty, MODERATION_RUNS_SHOWN, since) : [])));
    const view = (rows: Awaited<ReturnType<RunsRepository["moderationRuns"]>>) =>
      rows.map((row) => ({ runId: row.runId, survivalSec: row.survivalSec, points: row.points, level: row.level, enemiesKilled: row.enemiesKilled, startingWeaponId: row.startingWeaponId, finishedAt: row.finishedAt.toISOString(), ranked: row.ranked }));
    return { easy: view(lists[0] ?? []), normal: view(lists[1] ?? []), hard: view(lists[2] ?? []) };
  }

  private async boardBest(accountId: string, difficulty: Difficulty, board: Board): Promise<BestView | null> {
    if (!isRatedDifficulty(difficulty)) return null;
    const [best, rank] = await Promise.all([this.leaderboard.best(difficulty, accountId, board), this.leaderboard.rank(difficulty, accountId, board)]);
    if (best === null || rank === null) return null;
    // Время и стиль — у того же забега, что держит очки на доске.
    const run = await this.runs.bestRunOf(accountId, difficulty, false, this.rating.since());
    return { points: best, survivalSec: run?.survivalSec ?? 0, style: run?.style ?? null, rank };
  }

  private async shadowBest(accountId: string, difficulty: Difficulty, board: Board): Promise<BestView | null> {
    if (!isRatedDifficulty(difficulty)) return null;
    const mine = await this.runs.bestRunOf(accountId, difficulty, true, this.rating.since());
    if (mine === null || mine.points === null) return null;
    return { points: mine.points, survivalSec: mine.survivalSec, style: mine.style, rank: (await this.leaderboard.countAbove(difficulty, mine.points, board)) + 1 };
  }

  async detail(accountId: string, runId: string): Promise<RunDetailView> {
    // Части других модулей — параллельно строке забега: чужой или незнакомый
    // забег они не отдадут сами, ключ у всех — пара аккаунта и забега.
    const [run, extras] = await Promise.all([this.runs.detail(accountId, runId), this.extras.of(accountId, runId)]);
    if (run === null) throw new RunNotFoundError();
    return {
      runId: run.runId,
      difficultyId: run.difficulty,
      startingWeaponId: run.startingWeaponId,
      at: run.finishedAt.getTime(),
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      deathCause: run.outcome === "died" ? run.deathCause : null,
      weapons: run.weapons,
      passives: run.details?.passives ?? [],
      damageTaken: run.details?.damageTaken ?? null,
      xpCollected: run.details?.xpCollected ?? null,
      waveReached: run.details?.waveReached ?? null,
      topKills: run.details?.topKills ?? [],
      continues: run.continues,
      rating: ratingOf(run),
      points: run.points ?? null,
      ...extras,
    };
  }

  async review(limit: number): Promise<ReviewRow[]> {
    return await this.runs.review(limit);
  }
}

function ratingOf(run: Pick<RunDetailRow, "ranked" | "ratingRestricted" | "cheats">): RunDetailView["rating"] {
  if (run.ranked || run.ratingRestricted === "silent") return "ranked";
  if (run.ratingRestricted === "notified") return "restricted";
  return run.cheats ? "cheats" : "review";
}
