import { addTranslations } from "./index";
import friends from "./ru-friends.json";

/**
 * Тексты раздела «Друзья» (docs/35-stage4-plan.md §3.8) — своим словарём:
 * их читает только экран друзей, и первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(friends);

export const FRIENDS_TRANSLATIONS_READY = true;
