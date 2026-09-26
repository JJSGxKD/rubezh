/**
 * Маршруты панели — в хэше адреса: ссылку на карточку игрока можно отправить
 * соседу, «назад» в браузере работает, а статике на сервере не нужно знать
 * про маршруты (любой путь — тот же index.html).
 */

export interface Section {
  id: string;
  title: string;
  /** право, без которого раздел не показывается; сервер проверит его сам */
  permission: string;
}

/** Разделы в порядке меню. Новый раздел — строка здесь и экран в `screens/sections.tsx`. */
export const SECTIONS: readonly Section[] = [
  { id: "players", title: "Игроки", permission: "players.view" },
  { id: "review", title: "Разбор забегов", permission: "players.view" },
  { id: "funnel", title: "Воронка", permission: "analytics.gameplay.view" },
  { id: "roles", title: "Роли", permission: "roles.assign" },
  { id: "audit", title: "Аудит", permission: "audit.view" },
  { id: "fx", title: "Курсы", permission: "analytics.revenue.view" },
  { id: "diagnostics", title: "Диагностика", permission: "diagnostics.view" },
  { id: "exports", title: "Выгрузки", permission: "data.export" },
  { id: "links", title: "Ссылки", permission: "links.manage" },
  { id: "flags", title: "Флаги", permission: "flags.edit" },
];

export interface Route {
  section: string;
  /** объект раздела: игрок, отчёт; `null` — список */
  id: string | null;
}

export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((part) => part !== "");
  const [section, id] = parts;
  if (section === undefined) return null;
  return { section: decodeURIComponent(section), id: id === undefined ? null : decodeURIComponent(id) };
}

export function hrefOf(route: Route): string {
  return `#/${encodeURIComponent(route.section)}${route.id === null ? "" : `/${encodeURIComponent(route.id)}`}`;
}

export function visibleSections(permissions: readonly string[], sections: readonly Section[] = SECTIONS): Section[] {
  return sections.filter((section) => permissions.includes(section.permission));
}

/**
 * Куда вести: маршрут из адреса, если раздел открыт, иначе первый доступный.
 * `null` — не открыто ничего: у роли нет ни одного раздела этой версии панели.
 */
export function resolveRoute(route: Route | null, permissions: readonly string[], all: readonly Section[] = SECTIONS): Route | null {
  const sections = visibleSections(permissions, all);
  if (route !== null && sections.some((section) => section.id === route.section)) return route;
  const first = sections[0];
  return first === undefined ? null : { section: first.id, id: null };
}
