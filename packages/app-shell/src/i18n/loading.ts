import { addTranslations } from "./index";
import loading from "./ru-loading.json";

/**
 * Советы и предания экрана загрузки забега (design/art/meta-v2.md §9) —
 * своим словарём: колода растёт с игрой, а чанк интерфейса забега на пределе
 * бюджета. Едет в чанке карточки (`screens/run/LoadingCardNote.tsx`), который
 * лобби подтягивает в простое вместе с движком (`preloadRunEngine`).
 */
addTranslations(loading);

export const LOADING_TRANSLATIONS_READY = true;
