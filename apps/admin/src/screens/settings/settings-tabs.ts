import { groupSettings, type SettingRow } from "../../api/settings";

/**
 * Латинские имена групп настроек для адреса `#/settings/<имя>` (Р201). Ключ —
 * название группы, как его отдаёт сервер. Группы нет в таблице — в адресе её
 * название; новая группа каталога — строка здесь.
 */
export const SETTING_GROUP_SLUGS: Readonly<Record<string, string>> = {
  "Уведомления команде": "notify",
  "Магазин": "shop",
  "Ссылки Telegram": "links",
  "Функции сервера": "features",
  "Реклама": "ads",
  "Второй шанс": "continue",
  "Главная": "home",
  "Донаты": "donate",
  "Связь с разработчиком": "contact",
  "Внешние скрипты клиента": "client-scripts",
  "Онлайн": "online",
  "Лента событий": "feed",
  "Автоисточники": "auto-sources",
  "Сезоны рейтинга": "seasons",
  "Рейтинг": "rating",
  "Юзернейм бота": "bot-mention",
  "Достижения": "achievements",
  "Батл-пасс": "pass",
  "Прокси": "proxy",
  "Напоминания": "reminders",
  "Пролог": "prologue",
  "Сообщения бота": "bot-messages",
  "Партнёрка Telegram": "telegram-affiliate",
};

export interface SettingsTab {
  /** имя в адресе: из таблицы или название группы */
  id: string;
  title: string;
  rows: SettingRow[];
}

/** Вкладки в порядке каталога (`groupSettings`). */
export function settingsTabs(rows: readonly SettingRow[]): SettingsTab[] {
  return groupSettings([...rows]).map(({ group, rows: groupRows }) => ({
    id: SETTING_GROUP_SLUGS[group] ?? group,
    title: group,
    rows: groupRows,
  }));
}

/**
 * Что открыть по хвосту адреса: ключ настройки — её вкладка и строка; имя или
 * название группы — вкладка; иначе первая. Вкладок нет — `{ tab: null, focus: null }`.
 */
export function settingsTabOf(id: string | null, tabs: readonly SettingsTab[]): { tab: SettingsTab | null; focus: string | null } {
  const first = tabs[0] ?? null;
  if (id === null) return { tab: first, focus: null };
  const byKey = tabs.find((tab) => tab.rows.some((row) => row.key === id));
  if (byKey !== undefined) return { tab: byKey, focus: id };
  const byName = tabs.find((tab) => tab.id === id || tab.title === id);
  return { tab: byName ?? first, focus: null };
}
