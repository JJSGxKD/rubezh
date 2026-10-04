import { DomainError } from "../../common/domain-error.js";

/** Срок слайда команды вне пределов (`team-slide-rules.ts`). */
export class TeamSlidePeriodError extends DomainError {
  constructor(message: string) {
    super("team_slide_period", message, 400);
  }
}

/** Слайда нет, или он уже снят — панель перечитывает список. */
export class TeamSlideNotFoundError extends DomainError {
  constructor() {
    super("team_slide_not_found", "Слайда нет, или он уже снят", 404);
  }
}
