import { addTranslations } from "./index";
import boosts from "./ru-boosts.json";

/**
 * Имена и описания бустов (docs/35-stage4-plan.md §3.5, Р39). Нужны там, где
 * бусты выбирают, — до забега, а не в нём: поэтому не в словаре интерфейса
 * забега, у которого свой бюджет (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(boosts);

export const BOOSTS_TRANSLATIONS_READY = true;
