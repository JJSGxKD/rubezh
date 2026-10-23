import { Activity, BookOpen, Coins, Download, Filter, Flag, Gauge, Handshake, House, KeyRound, Link, ListChecks, Network, Percent, Send, ScrollText, ShieldAlert, SlidersHorizontal, Ticket, Tv, UserCog, Users, type LucideIcon } from "lucide-react";

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
  /** значок у пункта меню: по нему раздел находят глазами раньше, чем читают */
  icon: LucideIcon;
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
    sections: [{ id: "overview", title: "Сводка", hint: "Как идёт игра сегодня против вчера и что ждёт вас", permission: "analytics.gameplay.view", icon: Gauge }],
  },
  {
    title: "Поддержка",
    sections: [
      { id: "players", title: "Игроки", hint: "Найти игрока и открыть карточку: забеги, покупки, кошелёк, ограничения", permission: "players.view", icon: Users },
      { id: "review", title: "Разбор забегов", hint: "Забеги, которые антифрод счёл подозрительными или отклонил", permission: "players.view", icon: ShieldAlert },
    ],
  },
  {
    title: "Привлечение",
    sections: [
      { id: "funnel", title: "Воронка", hint: "Откуда приходят игроки и на каком шаге уходят", permission: "analytics.gameplay.view", icon: Filter },
      { id: "links", title: "Ссылки", hint: "Ссылки кампаний для постов и рекламы — клики и запуски по каждой", permission: "links.manage", icon: Link },
      { id: "partners", title: "Партнёры", hint: "Блогеры и каналы, которые приводят игроков своими кодами", permission: "partners.view", icon: Handshake },
      { id: "promo-codes", title: "Промокоды", hint: "Подарочные коды для стримов, постов и розыгрышей", permission: "promo.edit", icon: Ticket },
    ],
  },
  {
    title: "Доход",
    sections: [
      { id: "promos", title: "Акции", hint: "Скидки на товары магазина на срок", permission: "shop.promo.edit", icon: Percent },
      { id: "ads", title: "Реклама", hint: "Рекламные сети, их блоки и показы по местам в игре", permission: "ads.view", icon: Tv },
      { id: "fx", title: "Курсы", hint: "Курсы валют и звёзд, по которым считаются цены и выручка", permission: "analytics.revenue.view", icon: Coins },
    ],
  },
  {
    title: "Вовлечение",
    sections: [
      { id: "tasks", title: "Задания", hint: "Задания, достижения и задания рекламных сетей: цели, частота и награды", permission: "tasks.edit", icon: ListChecks },
      { id: "broadcasts", title: "Рассылки", hint: "Сообщения игрокам в бота с выбором аудитории", permission: "broadcast.edit", icon: Send },
      { id: "changelog", title: "Журнал обновлений", hint: "«Что нового» по версиям — игроки видят его в игре и в боте", permission: "changelog.edit", icon: BookOpen },
      { id: "home", title: "Главная", hint: "Слайды команды в карусели наверху главной игры", permission: "home.edit", icon: House },
    ],
  },
  {
    title: "Эксплуатация",
    sections: [
      { id: "flags", title: "Флаги", hint: "Включить функцию на площадке или доле игроков — без релиза", permission: "flags.edit", icon: Flag },
      { id: "settings", title: "Настройки", hint: "Чаты команды, переключатели и числа — без релиза", permission: "settings.edit", icon: SlidersHorizontal },
      { id: "secrets", title: "Ключи интеграций", hint: "Токены внешних сервисов: заменить без релиза, значение не показывается", permission: "secrets.view", icon: KeyRound },
      { id: "diagnostics", title: "Диагностика", hint: "Записи забегов и замеры производительности с устройств", permission: "diagnostics.view", icon: Activity },
      { id: "requests", title: "Запросы", hint: "Куда ходит сервер и что к нему приходит: внешние вызовы и сводка маршрутов", permission: "requests.view", icon: Network },
      { id: "exports", title: "Выгрузки", hint: "Архив событий и отчётов диагностики за период", permission: "data.export", icon: Download },
    ],
  },
  {
    title: "Команда",
    sections: [
      { id: "roles", title: "Роли", hint: "Кто из команды что может в панели", permission: "roles.assign", icon: UserCog },
      { id: "audit", title: "Аудит", hint: "Кто что изменил в панели и когда", permission: "audit.view", icon: ScrollText },
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

/**
 * Разделы меню по запросу: совпадение в названии или подсказке без регистра;
 * пусто — все. Группы без совпавших разделов уходят.
 */
export function filterGroups(groups: readonly SectionGroup[], query: string): SectionGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...groups];
  return groups
    .map((group) => ({ title: group.title, sections: group.sections.filter((section) => `${section.title} ${section.hint}`.toLowerCase().includes(needle)) }))
    .filter((group) => group.sections.length > 0);
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
