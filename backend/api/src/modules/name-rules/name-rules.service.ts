import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { cleanNameDetailed, type NameVerdict } from "../auth/display-name.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { NameRulesCache } from "./name-rules-cache.service.js";
import { compileNameRules, foldForRules, type NameRuleDef } from "./name-rules-engine.js";
import { NameRuleConflictError, NameRuleInvalidError, NameRuleNotFoundError } from "./name-rules-errors.js";
import { NAME_RULE_CATEGORIES, NAME_RULE_KINDS, NAME_RULE_LIMITS, type NameRuleCategory, type NameRuleKind } from "./name-rules-limits.js";
import { checkRegexSafety, probeRegex } from "./name-rules-safety.js";
import { NAME_RULES_REPOSITORY, type NameRulesRepository, type StoredNameRule } from "./name-rules.repository.js";

/**
 * Правила фильтра имён в панели (docs/29-admin-panel.md, docs/35-stage4-plan.md,
 * Р168): список, создание, правка, удаление и проверка на примерах. Всё под
 * правом `names.edit`; каждое изменение — в аудит и сообщением соседним
 * репликам. Шаблон правила в лог не пишется: он может быть чужим брендом.
 */

const DB_TIMEOUT_MS = 3_000;
const CANDIDATE_ID = "candidate";

export interface NameRuleInput {
  category: NameRuleCategory;
  kind: NameRuleKind;
  pattern: string;
  active?: boolean | undefined;
  note?: string | null | undefined;
}

export type NameRulePatchInput = Partial<NameRuleInput>;

export interface NameRuleView {
  ruleId: string;
  category: NameRuleCategory;
  kind: NameRuleKind;
  pattern: string;
  active: boolean;
  note: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface NameRulesView {
  rules: NameRuleView[];
  limits: { patternMax: number; noteMax: number; rulesMax: number; samplesMax: number; sampleMax: number };
}

export interface ProbeInput {
  /** правка существующего правила: кандидат заменяет его в наборе */
  ruleId?: string | undefined;
  category: NameRuleCategory;
  kind: NameRuleKind;
  pattern: string;
  samples: string[];
}

export interface ProbeResult {
  sample: string;
  name: string | null;
  verdict: NameVerdict;
  /** кандидат изменил результат: вырезал или заменил ник */
  candidateHit: boolean;
  /** кандидат — исключение и спас строку */
  saved: boolean;
}

interface Checked {
  category: NameRuleCategory;
  kind: NameRuleKind;
  pattern: string;
  active: boolean;
  note: string | null;
}

export function ruleView(row: StoredNameRule): NameRuleView {
  return { ruleId: row.ruleId, category: row.category, kind: row.kind, pattern: row.pattern, active: row.active, note: row.note, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy };
}

/** Ключ для поиска дубля: фразы сравниваются по свёртке (регистр, «ё»), регулярки — буквально. */
const dedupKey = (rule: { kind: NameRuleKind; pattern: string }): string => (rule.kind === "regex" ? rule.pattern : foldForRules(rule.pattern));

@Injectable()
export class NameRulesService {
  private readonly logger = new Logger("name-rules");

  constructor(
    @Inject(NAME_RULES_REPOSITORY) private readonly repository: NameRulesRepository,
    private readonly cache: NameRulesCache,
    private readonly roles: RolesService,
  ) {}

  async view(actor: AccountRef): Promise<NameRulesView> {
    await this.roles.require(actor, "names.edit");
    const rows = await this.db(this.repository.list());
    const { patternMax, noteMax, rulesMax, samplesMax, sampleMax } = NAME_RULE_LIMITS;
    return { rules: rows.map(ruleView), limits: { patternMax, noteMax, rulesMax, samplesMax, sampleMax } };
  }

  async create(actor: AccountRef, input: NameRuleInput, at = new Date()): Promise<NameRuleView> {
    await this.roles.require(actor, "names.edit");
    const checked = checkedRule({ active: true, note: null, ...input });
    if ((await this.db(this.repository.count())) >= NAME_RULE_LIMITS.rulesMax) throw new NameRuleConflictError(`Правил уже ${String(NAME_RULE_LIMITS.rulesMax)} — удалите лишние`);
    this.ensureUnique(checked, await this.db(this.repository.list()), null);

    const row: StoredNameRule = { ruleId: randomUUID(), ...checked, createdAt: at, updatedAt: at, updatedBy: actor.accountId };
    await this.db(this.repository.insert(row));
    const after = ruleView(row);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "names.rule.create", target: row.ruleId, after });
    await this.changed("name_rule_created", row.ruleId, actor);
    return after;
  }

  async update(actor: AccountRef, ruleId: string, patch: NameRulePatchInput, at = new Date()): Promise<NameRuleView> {
    await this.roles.require(actor, "names.edit");
    const rows = await this.db(this.repository.list());
    const before = rows.find((row) => row.ruleId === ruleId);
    if (before === undefined) throw new NameRuleNotFoundError();
    const checked = checkedRule({
      category: patch.category ?? before.category,
      kind: patch.kind ?? before.kind,
      pattern: patch.pattern ?? before.pattern,
      active: patch.active ?? before.active,
      note: patch.note === undefined ? before.note : patch.note,
    });
    this.ensureUnique(checked, rows, ruleId);

    const updated = await this.db(this.repository.update(ruleId, checked, at, actor.accountId));
    if (updated === null) throw new NameRuleNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "names.rule.update", target: ruleId, before: ruleView(before), after: ruleView(updated) });
    await this.changed("name_rule_updated", ruleId, actor);
    return ruleView(updated);
  }

  async remove(actor: AccountRef, ruleId: string): Promise<void> {
    await this.roles.require(actor, "names.edit");
    const before = (await this.db(this.repository.list())).find((row) => row.ruleId === ruleId);
    if (before === undefined) throw new NameRuleNotFoundError();
    if (!(await this.db(this.repository.remove(ruleId)))) throw new NameRuleNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "names.rule.delete", target: ruleId, before: ruleView(before) });
    await this.changed("name_rule_deleted", ruleId, actor);
  }

  /**
   * Что станет с примерами, если правило записать: действующие правила плюс
   * кандидат. Ничего не пишет и не аудируется — это просмотр, а не правка.
   */
  async probe(actor: AccountRef, input: ProbeInput): Promise<ProbeResult[]> {
    await this.roles.require(actor, "names.edit");
    const { samplesMax, sampleMax } = NAME_RULE_LIMITS;
    if (!Array.isArray(input.samples) || input.samples.length < 1 || input.samples.length > samplesMax) throw new NameRuleInvalidError(`Примеров — от 1 до ${String(samplesMax)}`);
    if (input.samples.some((sample) => typeof sample !== "string" || sample.length > sampleMax)) throw new NameRuleInvalidError(`Пример — не длиннее ${String(sampleMax)} знаков`);
    const checked = checkedRule({ category: input.category, kind: input.kind, pattern: input.pattern });

    const candidateId = input.ruleId ?? CANDIDATE_ID;
    const defs: NameRuleDef[] = (await this.db(this.repository.listActive())).filter((row) => row.ruleId !== candidateId);
    defs.push({ ruleId: candidateId, category: checked.category, kind: checked.kind, pattern: checked.pattern });
    const set = compileNameRules(defs);

    return input.samples.map((sample) => {
      const result = cleanNameDetailed(sample, set);
      return { sample, name: result.name, verdict: result.verdict, candidateHit: result.hits.includes(candidateId), saved: result.saved.includes(candidateId) };
    });
  }

  private ensureUnique(rule: Checked, rows: readonly StoredNameRule[], selfId: string | null): void {
    const key = dedupKey(rule);
    if (rows.some((row) => row.ruleId !== selfId && row.category === rule.category && row.kind === rule.kind && dedupKey(row) === key)) throw new NameRuleConflictError("Такое правило уже есть");
  }

  /** Сообщение репликам и строка в лог — без шаблона. Не ушло — реплики увидят правку при опросе. */
  private async changed(event: string, ruleId: string, actor: AccountRef): Promise<void> {
    try {
      await this.cache.publishChanged(ruleId);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "name_rules_not_published", ruleId, reason: error instanceof Error ? error.message : "unknown" }));
    }
    this.logger.log(JSON.stringify({ module: "name-rules", event, ruleId, actor: actor.accountId }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "правила имён");
  }
}

/** Правило по правилам: набор категорий и видов, длина, безопасная регулярка. */
function checkedRule(input: { category: unknown; kind: unknown; pattern: unknown; active?: boolean | undefined; note?: string | null | undefined }): Checked {
  const category = NAME_RULE_CATEGORIES.find((item) => item === input.category);
  if (category === undefined) throw new NameRuleInvalidError("Неизвестная категория правила");
  const kind = NAME_RULE_KINDS.find((item) => item === input.kind);
  if (kind === undefined) throw new NameRuleInvalidError("Неизвестный вид правила");
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  if (pattern.length < 1 || pattern.length > NAME_RULE_LIMITS.patternMax) throw new NameRuleInvalidError(`Шаблон — от 1 до ${String(NAME_RULE_LIMITS.patternMax)} знаков`);
  if (kind === "regex") {
    const safety = checkRegexSafety(pattern);
    if (!safety.ok) throw new NameRuleInvalidError(safety.reason);
    const probe = probeRegex(pattern);
    if (!probe.ok) throw new NameRuleInvalidError(probe.reason);
  } else if (foldForRules(pattern) === "") {
    throw new NameRuleInvalidError("Шаблон пуст");
  }
  const note = input.note === undefined || input.note === null ? null : input.note.trim();
  if (note !== null && note.length > NAME_RULE_LIMITS.noteMax) throw new NameRuleInvalidError(`Заметка — не длиннее ${String(NAME_RULE_LIMITS.noteMax)} знаков`);
  return { category, kind, pattern, active: input.active ?? true, note: note === "" ? null : note };
}
