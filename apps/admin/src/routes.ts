/**
 * Маршруты панели — в хэше адреса: ссылку на карточку игрока можно отправить
 * соседу, «назад» в браузере работает, а статике на сервере не нужно знать
 * про маршруты (любой путь — тот же index.html).
 */

export interface Section {
  id: string;
  title: string;
  /** что здесь делают — одной строкой: подсказка в меню и подзаголовок в шапке */
  hint: string;
  /** право, без которого раздел не показывается; сервер проверит его сам */
  permission: string;
}

export interface SectionGroup {
  title: string;
  sections: readonly Section[];
}

/**
 * Меню — группами по тому, какую работу в них делают, а не плоским списком:
 * восемнадцать пунктов подряд человек читает целиком, прежде чем найти свой.
 * Группа — вопрос, с которым приходят: «как дела сегодня», «что с игроком», «откуда приходят»,
 * «на чём зарабатываем», «чем возвращаем», «как работает система», «кто что
 * может». Внутри группы и группы между собой — от частого к редкому.
 *
 * Новый раздел — строка в своей группе и экран в `screens/sections.tsx`.
 */
export const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    title: "Обзор",
    sections: [{ id: "overview", title: "Сводка", hint: "Как идёт игра сегодня против вчера и что ждёт вас", permission: "analytics.gameplay.view" }],
  },
  {
    title: "Поддержка",
    sections: [
      { id: "players", title: "Игроки", hint: "Найти игрока и открыть карточку: забеги, покупки, кошелёк, блокировка", permission: "players.view" },
      { id: "review", title: "Разбор забегов", hint: "Забеги, которые антифрод счёл подозрительными или отклонил", permission: "players.view" },
    ],
  },
  {
    title: "Привлечение",
    sections: [
      { id: "funnel", title: "Воронка", hint: "Откуда приходят игроки и на каком шаге уходят", permission: "analytics.gameplay.view" },
      { id: "links", title: "Ссылки", hint: "Ссылки кампаний для постов и рекламы — клики и запуски по каждой", permission: "links.manage" },
      { id: "partners", title: "Партнёры", hint: "Блогеры и каналы, которые приводят игроков своими кодами", permission: "partners.view" },
      { id: "promo-codes", title: "Промокоды", hint: "Подарочные коды для стримов, постов и розыгрышей", permission: "promo.edit" },
    ],
  },
  {
    title: "Доход",
    sections: [
      { id: "promos", title: "Акции", hint: "Скидки на товары магазина на срок", permission: "shop.promo.edit" },
      { id: "ads", title: "Реклама", hint: "Рекламные сети, их блоки и показы по местам в игре", permission: "ads.view" },
      { id: "fx", title: "Курсы", hint: "Курсы валют и звёзд, по которым считаются цены и выручка", permission: "analytics.revenue.view" },
    ],
  },
  {
    title: "Вовлечение",
    sections: [
      { id: "tasks", title: "Задания", hint: "Ежедневные и недельные задания и достижения: цели и награды", permission: "tasks.edit" },
      { id: "broadcasts", title: "Рассылки", hint: "Сообщения игрокам в бота с выбором аудитории", permission: "broadcast.edit" },
      { id: "changelog", title: "Журнал обновлений", hint: "«Что нового» по версиям — игроки видят его в игре и в боте", permission: "changelog.edit" },
    ],
  },
  {
    title: "Эксплуатация",
    sections: [
      { id: "flags", title: "Флаги", hint: "Включить функцию на площадке или доле игроков — без релиза", permission: "flags.edit" },
      { id: "settings", title: "Настройки", hint: "Адреса чатов команды и переключатели без релиза", permission: "settings.edit" },
      { id: "secrets", title: "Ключи интеграций", hint: "Токены внешних сервисов: заменить без релиза, значение не показывается", permission: "secrets.view" },
      { id: "diagnostics", title: "Диагностика", hint: "Записи забегов и замеры производительности с устройств", permission: "diagnostics.view" },
      { id: "exports", title: "Выгрузки", hint: "Архив событий и отчётов диагностики за период", permission: "data.export" },
    ],
  },
  {
    title: "Команда",
    sections: [
      { id: "roles", title: "Роли", hint: "Кто из команды что может в панели", permission: "roles.assign" },
      { id: "audit", title: "Аудит", hint: "Кто что изменил в панели и когда", permission: "audit.view" },
    ],
  },
];

/** Все разделы подряд, в порядке меню. */
export const SECTIONS: readonly Section[] = SECTION_GROUPS.flatMap((group) => group.sections);

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

/** Меню по правам: группа без единого открытого раздела не показывается вовсе. */
export function visibleGroups(permissions: readonly string[], groups: readonly SectionGroup[] = SECTION_GROUPS): SectionGroup[] {
  return groups.map((group) => ({ title: group.title, sections: visibleSections(permissions, group.sections) })).filter((group) => group.sections.length > 0);
}

/** Где раздел в меню — для шапки и заголовка вкладки браузера. */
export function locateSection(id: string, groups: readonly SectionGroup[] = SECTION_GROUPS): { group: SectionGroup; section: Section } | null {
  for (const group of groups) {
    const section = group.sections.find((candidate) => candidate.id === id);
    if (section !== undefined) return { group, section };
  }
  return null;
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
