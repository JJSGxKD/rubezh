/**
 * Правила фильтра имён (docs/35-stage4-plan.md, Р168): категории, виды и
 * пределы. Категория задаёт действие, вид — как искать шаблон; пределы
 * держат горячий путь входа: правила исполняются на нике каждого игрока.
 */

/** Порядок важен: правила применяются в нём (сначала исключения, потом вырезание, потом мат). */
export const NAME_RULE_CATEGORIES = ["profanity", "brand", "ads", "other", "allow"] as const;
export type NameRuleCategory = (typeof NAME_RULE_CATEGORIES)[number];

export const NAME_RULE_KINDS = ["exact", "word", "regex"] as const;
export type NameRuleKind = (typeof NAME_RULE_KINDS)[number];

export const NAME_RULE_LIMITS = {
  /** знаков в правиле */
  patternMax: 100,
  noteMax: 200,
  /** правил всего: потолок работы на горячем пути входа */
  rulesMax: 2000,
  /** знаков ника, которые смотрят правила: в итоге всё равно остаётся 24 графемы */
  inputMax: 512,
  /** совпадений одного правила в одном нике: регулярка вроде `.` иначе вырезала бы всё */
  matchesPerRule: 20,
  /** строк в окне «проверить на примерах» */
  samplesMax: 20,
  sampleMax: 256,
  /** «*», «+», «{n,}» в одной регулярке: каждый добавляет степень перебору */
  unboundedMax: 3,
  /** верхняя граница в «{n,m}» */
  repeatMax: 20,
  /** миллисекунд на одну «злую» строку при сохранении регулярки */
  probeBudgetMs: 25,
} as const;
