import { DomainError } from "../../common/domain-error.js";

/** Награды нет: ключ сезона не тот или она чужая — игрок не узнаёт, какое из двух. */
export class SeasonRewardNotFoundError extends DomainError {
  constructor() {
    super("season_reward_not_found", "Награда сезона не найдена", 404);
  }
}
