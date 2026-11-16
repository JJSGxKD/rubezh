import { addTranslations } from "./index";
import playerCard from "./ru-player-card.json";

/**
 * Тексты карточки игрока (docs/35-stage4-plan.md Р48, tasks/T-0248) — своим
 * словарём: их читают рейтинг, друзья и профиль, а первая загрузка за них не
 * платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(playerCard);

export const PLAYER_CARD_TRANSLATIONS_READY = true;
