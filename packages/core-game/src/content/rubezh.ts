import { RUBEZH_AT_SEC, type EnemyDef, type RubezhDef } from "@bh/shared-types";

/**
 * Рубеж: цель забега (docs/39-retention-mechanics.md Б6, docs/35-stage4-plan.md
 * Р102, Р105). На отметке приходит страж; убитый страж — победа, она
 * записывается в итог, а забег идёт дальше бесконечным режимом.
 *
 * Отметка — `RUBEZH_AT_SEC` из `shared-types`: её читает и сервер, проверяя
 * заявленную победу. Сам страж — запись в `content/enemies.ts`, здесь только
 * ссылка на неё. Числа стартовые, калибрует геймдизайнер.
 */
export const RUBEZH: RubezhDef = {
  atSec: RUBEZH_AT_SEC,
  guard: "rubezh_guard",
};

/** Во сколько раз страж крепче самого крепкого из прочих боссов: иначе «главный бой» слабее побочного. */
export const GUARD_HP_MIN_RATIO = 1.3;

/** Паттерны со снарядами: в бою их нет (Р69), страж не исключение. */
const SHOOTING_PATTERNS: readonly string[] = ["kite_and_shoot", "caster"];
const SHOOTING_PARAMS: readonly string[] = ["projectileSpeed", "shotIntervalSec"];

/**
 * Замечания к описанию рубежа. Пусто — всё в порядке. Сообщение называет
 * поле, чтобы правщик контента видел, что чинить.
 */
export function findRubezhProblems(def: RubezhDef, enemies: readonly EnemyDef[]): string[] {
  const problems: string[] = [];

  if (!(def.atSec > 0)) problems.push(`rubezh.atSec — больше 0, сейчас ${def.atSec}`);

  const guard = enemies.find((enemy) => enemy.id === def.guard);
  if (guard === undefined) {
    problems.push(`rubezh.guard — врага ${def.guard} нет в контенте`);
    return problems;
  }

  if (guard.rank !== "boss") {
    // Без ранга босса у стража нет полосы здоровья, а событиям таймлайна нечего пропускать.
    problems.push(`rubezh.guard — враг ${guard.id} должен быть босс (rank: "boss"), сейчас ${guard.rank ?? "обычный"}`);
  }
  const params: Readonly<Record<string, unknown>> = guard.params ?? {};
  if (SHOOTING_PATTERNS.includes(guard.pattern) || SHOOTING_PARAMS.some((key) => key in params)) {
    problems.push(`rubezh.guard — враг ${guard.id} со снарядами: в бою их нет (Р69)`);
  }

  const toughest = Math.max(0, ...enemies.filter((enemy) => enemy.rank === "boss" && enemy.id !== guard.id).map((enemy) => enemy.hp));
  if (guard.hp < toughest * GUARD_HP_MIN_RATIO) {
    problems.push(
      `rubezh.guard — здоровье ${guard.hp} ниже 1,3 здоровья самого крепкого из прочих боссов (${toughest})`,
    );
  }
  return problems;
}
