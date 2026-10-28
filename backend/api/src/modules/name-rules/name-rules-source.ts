import type { NameRuleSet } from "./name-rules-engine.js";

/**
 * Порт, через который чистка ника получает правила. Отдельным файлом от кэша:
 * хранилище аккаунтов и команда `names:clean` тянут только порт, а не Redis и
 * конфигурацию, которые нужны кэшу.
 */
export interface NameRulesSource {
  current(): NameRuleSet;
}

export const NAME_RULES = Symbol("NAME_RULES");
