import { DomainError } from "../../common/domain-error.js";

/**
 * В любимые ставят только полученное достижение: чужое, невыполненное и
 * несуществующее — одна ошибка, и по ней не узнать, есть ли такое достижение.
 */
export class AchievementNotUnlockedError extends DomainError {
  constructor() {
    super("achievement_not_unlocked", "Это достижение ещё не получено — в любимые можно поставить только полученное", 409);
  }
}
