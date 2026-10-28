import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { NameRuleConflictError } from "./name-rules-errors.js";
import { compileNameRules, type NameRuleSet } from "./name-rules-engine.js";
import type { NameRuleCategory, NameRuleKind } from "./name-rules-limits.js";

/**
 * Правила фильтра имён в базе (`name_rule`, docs/35-stage4-plan.md, Р168).
 * Запрос к базе живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

export interface StoredNameRule {
  ruleId: string;
  category: NameRuleCategory;
  kind: NameRuleKind;
  pattern: string;
  active: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** кто менял последним; без внешнего ключа — запись переживает аккаунт */
  updatedBy: string | null;
}

export type NameRulePatch = Partial<Pick<StoredNameRule, "category" | "kind" | "pattern" | "active" | "note">>;

export const NAME_RULES_REPOSITORY = Symbol("NAME_RULES_REPOSITORY");

export interface NameRulesRepository {
  /** все правила, по времени создания */
  list(): Promise<StoredNameRule[]>;
  listActive(): Promise<StoredNameRule[]>;
  findByKey(category: NameRuleCategory, kind: NameRuleKind, pattern: string): Promise<StoredNameRule | null>;
  count(): Promise<number>;
  insert(row: StoredNameRule): Promise<void>;
  /** изменённая строка; `null` — такого правила нет */
  update(ruleId: string, patch: NameRulePatch, at: Date, by: string | null): Promise<StoredNameRule | null>;
  /** `false` — такого правила и не было */
  remove(ruleId: string): Promise<boolean>;
}

const UNIQUE_VIOLATION = "P2002";

/** Гонка двух правок с одной тройкой: уникальный индекс срабатывает позже проверки сервиса. */
function asConflict(error: unknown): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION ? new NameRuleConflictError("Такое правило уже есть") : error;
}

@Injectable()
export class PrismaNameRulesRepository implements NameRulesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(): Promise<StoredNameRule[]> {
    return await this.prisma.nameRule.findMany({ orderBy: [{ createdAt: "asc" }, { ruleId: "asc" }] });
  }

  async listActive(): Promise<StoredNameRule[]> {
    return await this.prisma.nameRule.findMany({ where: { active: true }, orderBy: { ruleId: "asc" } });
  }

  async findByKey(category: NameRuleCategory, kind: NameRuleKind, pattern: string): Promise<StoredNameRule | null> {
    return await this.prisma.nameRule.findUnique({ where: { category_kind_pattern: { category, kind, pattern } } });
  }

  async count(): Promise<number> {
    return await this.prisma.nameRule.count();
  }

  async insert(row: StoredNameRule): Promise<void> {
    try {
      await this.prisma.nameRule.create({ data: row });
    } catch (error: unknown) {
      throw asConflict(error);
    }
  }

  async update(ruleId: string, patch: NameRulePatch, at: Date, by: string | null): Promise<StoredNameRule | null> {
    try {
      return await this.prisma.nameRule.update({ where: { ruleId }, data: { ...patch, updatedAt: at, updatedBy: by } });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return null;
      throw asConflict(error);
    }
  }

  async remove(ruleId: string): Promise<boolean> {
    const { count } = await this.prisma.nameRule.deleteMany({ where: { ruleId } });
    return count > 0;
  }
}

/**
 * Набор действующих правил для процессов без Nest: команда `names:clean`
 * читает базу сама. Битое правило пропускается с причиной в `onInvalid`.
 */
export async function loadNameRuleSet(prisma: PrismaClient, onInvalid?: (def: { ruleId: string }, reason: string) => void): Promise<NameRuleSet> {
  const rows = await prisma.nameRule.findMany({ where: { active: true }, orderBy: { ruleId: "asc" } });
  return compileNameRules(rows, onInvalid);
}
