import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { REDIS } from "../../infra/redis.js";
import { cleanNameDetailed } from "../auth/display-name.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { CANDIDATE_RULES } from "./name-rule-candidates-rules.js";
import { tokensOf } from "./name-rule-candidates-tokens.js";
import { NAME_RULE_CANDIDATES_REPOSITORY, type CandidateItem, type CandidateKind, type NameRuleCandidatesRepository } from "./name-rule-candidates.repository.js";
import { protectedSpans } from "./name-rules-engine.js";
import { NameRuleNotFoundError } from "./name-rules-errors.js";
import { loadNameRuleSet } from "./name-rules.repository.js";
import { NameRulesService, type NameRuleView } from "./name-rules.service.js";

/**
 * Кандидаты в правила фильтра имён (Р168, tasks/T-0341). Ночной расчёт: слова и
 * пары слов, встреченные у `minPlayers` и более разных игроков за 30 суток по
 * исходному нику. Наружу выходит только слово и число игроков — игроки считаются
 * в памяти прохода и не сохраняются, `accountId` нужен лишь как курсор пачки.
 * Решение по кандидату — кнопки панели: правило через обычный `NameRulesService`
 * или «не нужно».
 */

const LOCK_KEY = "name-rules:candidates:lock";
const LAST_KEY = "name-rules:candidates:last";
const LAST_TTL_SEC = 3 * 86_400;
const REDIS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** Продлить замок, только пока он наш: чужой не трогается. */
const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export interface CandidateRunResult {
  status: "done" | "skipped";
  scanned: number;
  kept: number;
  /** слов оказалось больше, чем держит проход: новые перестали заводиться */
  capped: boolean;
}

const SKIPPED: CandidateRunResult = { status: "skipped", scanned: 0, kept: 0, capped: false };

@Injectable()
export class NameRuleCandidatesService {
  private readonly logger = new Logger("name-rules");
  /** Часы; тест двигает их. */
  clock: () => Date = () => new Date();
  /** Пределы — полями, чтобы тест не создавал миллион слов; в проде — числа из `CANDIDATE_RULES`. */
  pageSize: number = CANDIDATE_RULES.pageSize;
  mapMax: number = CANDIDATE_RULES.mapMax;
  keepMax: number = CANDIDATE_RULES.keepMax;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    @Inject(NAME_RULE_CANDIDATES_REPOSITORY) private readonly repository: NameRuleCandidatesRepository,
  ) {}

  /**
   * Один расчёт под замком: одна реплика считает, остальные пропускают.
   * `dryRun` — посчитать и ничего не записать: ни таблицу, ни итог в Redis.
   */
  async run(options: { dryRun?: boolean } = {}): Promise<CandidateRunResult> {
    const token = randomUUID();
    const locked = await withTimeout(this.redis.set(LOCK_KEY, token, "PX", CANDIDATE_RULES.lockTtlMs, "NX"), REDIS_TIMEOUT_MS, "кандидаты в правила имён: замок");
    if (locked === null) return SKIPPED;
    try {
      return await this.compute(token, options.dryRun === true);
    } finally {
      await this.release(token);
    }
  }

  private async compute(lockToken: string, dryRun: boolean): Promise<CandidateRunResult> {
    const startedAt = this.clock();
    // Свежий набор, не кэш: расчёт идёт раз в сутки, а «закрытое» должно быть закрыто сейчас.
    const rules = await withTimeout(loadNameRuleSet(this.prisma), DB_TIMEOUT_MS, "кандидаты в правила имён: правила");
    const since = new Date(startedAt.getTime() - CANDIDATE_RULES.windowDays * DAY_MS);
    const counts = new Map<string, number>();
    let capped = false;
    let scanned = 0;
    let cursor: string | null = null;

    for (;;) {
      const rows: { accountId: string; platformName: string | null; displayName: string }[] = await withTimeout(
        this.prisma.account.findMany({
          where: { lastSeenAt: { gte: since }, ...(cursor === null ? {} : { accountId: { gt: cursor } }) },
          orderBy: { accountId: "asc" },
          take: this.pageSize,
          select: { accountId: true, platformName: true, displayName: true },
        }),
        DB_TIMEOUT_MS,
        "кандидаты в правила имён: аккаунты",
      );
      const last = rows.at(-1);
      if (last === undefined) break;
      cursor = last.accountId;
      scanned += rows.length;
      for (const row of rows) {
        // Исходник: в очищенном нике уже нет того, что мы вырезаем.
        const { words, pairs } = tokensOf(row.platformName ?? row.displayName);
        // Ключ на ник — один раз: это и есть «разные игроки».
        for (const word of words) capped = this.bump(counts, `w:${word}`) || capped;
        for (const pair of pairs) capped = this.bump(counts, `p:${pair}`) || capped;
      }
      await this.extend(lockToken);
    }

    const items = this.selected(counts, rules);
    const result: CandidateRunResult = { status: "done", scanned, kept: items.length, capped };
    if (!dryRun) {
      await withTimeout(this.repository.save(items, startedAt), DB_TIMEOUT_MS, "кандидаты в правила имён: запись");
      await this.remember(result);
    }
    // В лог — только числа: слово может быть чужим брендом.
    this.logger.log(JSON.stringify({ module: "name-rules", event: "candidates_computed", scanned, kept: items.length, capped }));
    return result;
  }

  /** +1 ключу; `true` — ключ новый и в память не поместился. */
  private bump(counts: Map<string, number>, key: string): boolean {
    const current = counts.get(key);
    if (current !== undefined) {
      counts.set(key, current + 1);
      return false;
    }
    if (counts.size >= this.mapMax) return true;
    counts.set(key, 1);
    return false;
  }

  /** Достигшие порога и не закрытые ничем, самые частые — не больше `keepMax`. */
  private selected(counts: Map<string, number>, rules: Awaited<ReturnType<typeof loadNameRuleSet>>): CandidateItem[] {
    const items: CandidateItem[] = [];
    for (const [key, players] of counts) {
      if (players < CANDIDATE_RULES.minPlayers) continue;
      const kind: CandidateKind = key.startsWith("w:") ? "word" : "pair";
      const token = key.slice(2);
      if (isClosed(token, rules)) continue;
      items.push({ token, kind, players });
    }
    items.sort((left, right) => right.players - left.players || left.token.localeCompare(right.token));
    return items.slice(0, this.keepMax);
  }

  private async remember(result: CandidateRunResult): Promise<void> {
    const body = JSON.stringify({ computedAt: this.clock().toISOString(), scanned: result.scanned, kept: result.kept, capped: result.capped });
    try {
      await withTimeout(this.redis.set(LAST_KEY, body, "EX", LAST_TTL_SEC), REDIS_TIMEOUT_MS, "кандидаты в правила имён: итог");
    } catch (error: unknown) {
      // Итог нужен только подписи на вкладке; без него расчёт не откатывается.
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_last_not_saved", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  private async extend(token: string): Promise<void> {
    try {
      await withTimeout(this.redis.eval(EXTEND_SCRIPT, 1, LOCK_KEY, token, String(CANDIDATE_RULES.lockTtlMs)) as Promise<unknown>, REDIS_TIMEOUT_MS, "кандидаты в правила имён: продление замка");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_lock_not_extended", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  private async release(token: string): Promise<void> {
    try {
      await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token) as Promise<unknown>, REDIS_TIMEOUT_MS, "кандидаты в правила имён: снятие замка");
    } catch (error: unknown) {
      // Замок живёт не дольше TTL: следующая ночь увидит его свободным.
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_lock_not_released", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }
}

/**
 * Слово уже закрыто: правило или встроенный словарь его трогают, либо
 * исключение уже защищает. Только обрезка по длине закрытием не считается.
 */
function isClosed(token: string, rules: Awaited<ReturnType<typeof loadNameRuleSet>>): boolean {
  const { verdict } = cleanNameDetailed(token, rules);
  if (verdict !== "ok" && verdict !== "trimmed") return true;
  return protectedSpans(rules, token).spans.length > 0;
}

export interface CandidateView {
  candidateId: string;
  token: string;
  kind: CandidateKind;
  players: number;
  firstSeenAt: string;
}

export interface CandidatesView {
  /** когда считали в последний раз; `null` — расчёта ещё не было */
  computedAt: string | null;
  minPlayers: number;
  windowDays: number;
  items: CandidateView[];
}

export interface AcceptInput {
  category: "profanity" | "brand" | "ads" | "other" | "allow";
  kind: "exact" | "word";
}

const lastSchema = z.object({ computedAt: z.string() });

/** Кандидаты для панели: список, «в стирания» и «в исключения», «не нужно». Всё под `names.edit`. */
@Injectable()
export class NameRuleCandidatesAdminService {
  private readonly logger = new Logger("name-rules");

  constructor(
    @Inject(NAME_RULE_CANDIDATES_REPOSITORY) private readonly repository: NameRuleCandidatesRepository,
    private readonly roles: RolesService,
    private readonly nameRules: NameRulesService,
    @Inject(REDIS) private readonly redis: Pick<Redis, "get">,
  ) {}

  async list(actor: AccountRef): Promise<CandidatesView> {
    await this.roles.require(actor, "names.edit");
    const [rows, computedAt] = await Promise.all([withTimeout(this.repository.list(CANDIDATE_RULES.listMax), DB_TIMEOUT_MS, "кандидаты: список"), this.computedAt()]);
    const items = rows.map((row) => ({ candidateId: row.candidateId, token: row.token, kind: row.kind, players: row.players, firstSeenAt: row.firstSeenAt.toISOString() }));
    return { computedAt, minPlayers: CANDIDATE_RULES.minPlayers, windowDays: CANDIDATE_RULES.windowDays, items };
  }

  /**
   * «В стирания» и «в исключения»: слово становится обычным правилом — те же
   * проверки, лимиты и аудит `names.rule.create`, что у правила из формы. Ошибка
   * правила (дубль, потолок) всплывает как есть, и кандидат остаётся.
   */
  async accept(actor: AccountRef, candidateId: string, input: AcceptInput): Promise<NameRuleView> {
    await this.roles.require(actor, "names.edit");
    const candidate = await withTimeout(this.repository.find(candidateId), DB_TIMEOUT_MS, "кандидаты: поиск");
    if (candidate === null) throw new NameRuleNotFoundError();
    const rule = await this.nameRules.create(actor, { category: input.category, kind: input.kind, pattern: candidate.token });
    await withTimeout(this.repository.remove(candidateId), DB_TIMEOUT_MS, "кандидаты: удаление");
    return rule;
  }

  /** «Не нужно»: скрыть до забывания. В аудит — вид, без слова: журнал видят шире, чем экран. */
  async dismiss(actor: AccountRef, candidateId: string, at = new Date()): Promise<{ dismissed: true }> {
    await this.roles.require(actor, "names.edit");
    const dismissed = await withTimeout(this.repository.dismiss(candidateId, actor.accountId, at), DB_TIMEOUT_MS, "кандидаты: скрытие");
    if (dismissed === null) throw new NameRuleNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "names.candidate.dismiss", target: candidateId, after: { kind: dismissed.kind } });
    return { dismissed: true };
  }

  private async computedAt(): Promise<string | null> {
    try {
      const raw = await withTimeout(this.redis.get(LAST_KEY), REDIS_TIMEOUT_MS, "кандидаты: итог расчёта");
      if (raw === null) return null;
      const parsed = lastSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.computedAt : null;
    } catch (error: unknown) {
      // Подпись «посчитано» — удобство, не данные: без Redis список всё равно отдаётся.
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_last_unreadable", reason: error instanceof Error ? error.name : "unknown" }));
      return null;
    }
  }
}
