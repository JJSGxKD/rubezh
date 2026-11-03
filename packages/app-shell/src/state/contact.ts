import { create } from "zustand";
import { openExternalLink } from "./external-link";
import { trackClick } from "./ui-clicks";

/**
 * Ссылка кнопки «Связаться с разработчиком» (docs/35-stage4-plan.md Р173):
 * сервер выбирает её по площадке из токена и отдаёт вместе со знаками меню.
 * Отдельно от `useBadges`: там только числа.
 */
export interface Contact {
  url: string | null;
  set(url: string | null): void;
}

export const useContact = create<Contact>()((set) => ({ url: null, set: (url) => set({ url }) }));

/** Ссылка для пункта; не https — `null`: вторая защита после каталога настроек. */
export function contactHref(url: string | null = useContact.getState().url): string | null {
  return url !== null && url.startsWith("https://") ? url : null;
}

/** Нажатие пункта: считает клик и открывает ссылку в том же касании — площадка пускает ссылки только так. */
export function openContact(): void {
  const href = contactHref();
  if (href === null) return;
  trackClick("contact");
  openExternalLink(href);
}
