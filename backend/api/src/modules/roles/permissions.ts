/**
 * Права и роли панели управления (docs/29-admin-panel.md §3).
 *
 * **Право — конкретное действие, роль — набор прав, и оба живут в коде.**
 * Состав роли меняется через ревью, а не кликом в интерфейсе: иначе однажды
 * «модератору временно дали посмотреть выручку» и забыли. Данными остаётся
 * только то, у кого какая роль (таблица `account_role`).
 *
 * **Почему перечень здесь, а не в `packages/shared-types`.** План этапа
 * предполагал `shared-types`, но собранный бэкенд не может импортировать
 * исходники пакетов монорепо — по той же причине там живёт и словарь событий
 * (docs/22-analytics-and-metrics.md §3.3). Клиенту полный перечень и не
 * нужен: сервер отдаёт ему готовый ответ, что открыто, а решение всегда
 * принимает сам (docs/29-admin-panel.md §3.4).
 *
 * Перечень полный по матрице §3.3 сразу, хотя модулей под него пока три:
 * таблица прав дёшева, пока её пишут с нуля, и дорога, когда её вшивают в
 * готовые модули задним числом (docs/34-stage3-plan.md, Р8).
 */

export const PERMISSIONS = [
  // Контент и баланс (docs/19-content-admin.md)
  "content.view",
  "content.edit",
  "content.publish",
  // Цены SKU: правит геймдизайнер, одобряет владелец — правило двух ключей
  "sku.price.view",
  "sku.price.edit",
  "sku.price.approve",
  // Аналитика
  "analytics.gameplay.view",
  "analytics.revenue.view",
  // Игроки
  "players.view",
  "players.pii.view",
  "players.ban",
  // Ручное начисление и списание в кошельке игрока — только владельцу: право
  // начислять валюту дороже любого другого права над игроками
  "players.wallet.adjust",
  // Рассылки и каналы
  "broadcast.edit",
  "broadcast.send",
  "broadcast.approve",
  "channel.post.edit",
  "channel.post.approve",
  // Бухгалтерия и распределение дохода (docs/11-revenue-split.md)
  "finance.entry.create",
  "finance.period.close",
  // Заданные руками курсы валют площадок — курс выплаты звёзд определяет
  // выручку, поэтому только владельцу (docs/35-stage4-plan.md, §3.12)
  "fx.rates.edit",
  "revenue.split.view",
  "revenue.split.own.view",
  // Реклама и партнёры
  "ads.view",
  "ads.edit",
  "partners.view",
  "partners.edit",
  "partners.payout.create",
  "partners.payout.approve",
  // Эксплуатация
  "flags.edit",
  "diagnostics.view",
  "data.export",
  // Инструменты команды в клиенте: режим разработчика, витрина, лаборатория
  "tools.dev",
  // Роли и журнал
  "roles.assign",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "owner",
  "admin",
  "game_designer",
  "moderator",
  "marketer",
  "finance",
  "analyst",
  "stakeholder",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Состав ролей по матрице модулей (docs/29-admin-panel.md §3.3).
 *
 * Владелец выписан не звёздочкой, а перечнем: звёздочка молча раздаёт каждое
 * новое право, и однажды это окажется правом, которого у человека быть не
 * должно. Список проверяется тестом — он падает, когда право появилось, а в
 * роли его не отметили.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,

  // Операционка без бухгалтерии и ролей: игроки, реклама, флаги, диагностика,
  // одобрение рассылок и выгрузки.
  admin: [
    "content.view",
    "sku.price.view",
    "analytics.gameplay.view",
    "analytics.revenue.view",
    "players.view",
    "players.pii.view",
    "players.ban",
    "broadcast.edit",
    "broadcast.send",
    "broadcast.approve",
    "channel.post.edit",
    "channel.post.approve",
    "ads.view",
    "ads.edit",
    "partners.view",
    "partners.edit",
    "flags.edit",
    "diagnostics.view",
    "data.export",
    "tools.dev",
    "audit.view",
  ],

  // Контент, баланс и аналитика геймплея; цена SKU — с одобрением владельца.
  game_designer: [
    "content.view",
    "content.edit",
    "content.publish",
    "sku.price.view",
    "sku.price.edit",
    "analytics.gameplay.view",
    "analytics.revenue.view",
    "players.view",
    "ads.view",
    "diagnostics.view",
    "tools.dev",
  ],

  // Игроки без платёжных данных, жалобы, блокировки, очередь антифрода.
  moderator: ["players.view", "players.ban"],

  // Привлечение и рассылки; партнёры без выплат.
  marketer: [
    "analytics.gameplay.view",
    "analytics.revenue.view",
    "broadcast.edit",
    "channel.post.edit",
    "ads.view",
    "partners.view",
    "partners.edit",
  ],

  // Операции и подготовка выплат; период закрывает только владелец.
  finance: [
    "sku.price.view",
    "analytics.revenue.view",
    "finance.entry.create",
    "revenue.split.view",
    "partners.view",
    "partners.payout.create",
  ],

  // Только чтение дашбордов, без персональных данных.
  analyst: ["content.view", "analytics.gameplay.view"],

  // Свой расчёт распределения дохода и сводный отчёт (docs/11-revenue-split.md §5).
  stakeholder: ["revenue.split.own.view"],
};

/** Все права роли-набора. Ролей у человека может быть несколько. */
export function permissionsOf(roles: readonly Role[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return granted;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
