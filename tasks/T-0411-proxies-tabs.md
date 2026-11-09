---
id: T-0411
title: Раздел «Прокси» — вкладки с адресом вместо одной ленты
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0410, T-0384, T-0386]
zones:
  - apps/admin/src/screens/proxies/ProxiesScreen.tsx
  - apps/admin/src/screens/proxies/proxies-tabs.ts
  - apps/admin/test/proxies-tabs.test.ts
shared:
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: self
design: null
batch: 5
---

# T-0411. Раздел «Прокси» — вкладки с адресом вместо одной ленты

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0411.json)](README.md#значки-статуса) [![T-0410](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0410.json&label=T-0410)](T-0410-admin-tab-bar.md) [![T-0384](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0384.json&label=T-0384)](T-0384-xray-multi-subscription.md) [![T-0386](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0386.json&label=T-0386)](T-0386-xray-traffic-stats.md)

## Зачем

Раздел «Прокси» — одна длинная лента: подписки Xray с таблицами узлов,
трафик, ручные прокси, режимы сервисов. До режимов приходится долго
листать, ссылку на нужное место не отправить. После задачи у раздела
вкладки с адресом `#/proxies/<вкладка>`, как у карточки партнёра. Что
делают панели, не меняется.

## Решения

- **Р201** (`docs/35-stage4-plan.md`), решение тимлида по входящему
  владельца:
  - вкладки «Прокси» — `#/proxies/<вкладка>`: «Подписки Xray», «Трафик»,
    «Ручные прокси», «Режимы»;
  - вкладку «Ядро Xray» добавит отдельная задача одной строкой списка;
  - вид — строка с чертой снизу, общий `TabBar` (T-0410);
  - это перестановка интерфейса, поведение панелей то же.

Решения `claude-lead-1` по коду:

1. **Вкладки и что на них** (панели переносятся как есть):

   | id | Название | Что на вкладке |
   |---|---|---|
   | `xray` | Подписки Xray | `SubscriptionPanel` (T-0384: список подписок, карточки, узлы) |
   | `traffic` | Трафик | `TrafficPanel` (T-0386) |
   | `manual` | Ручные прокси | панель «Прокси» со списком `ProxyCard`, «Обновить», «Добавить прокси» и `ProxyDialog` |
   | `modes` | Режимы | `ModesPanel` |

   Вкладка «Ручные прокси», а не «Прокси»: раздел уже называется «Прокси».
   Документы и T-0384 зовут эти прокси ручными.
2. **Порядок — как панели стоят сейчас.** Первая и по умолчанию —
   «Подписки Xray».
3. **Адрес.** У раздела нет объектов, поэтому вкладка — вторая часть
   адреса, `id` маршрута: `#/proxies/modes`. Вкладка по умолчанию — без
   хвоста: `#/proxies`. Неизвестный хвост открывает «Подписки Xray», как
   `cardTabOf` у карточки игрока. Смена вкладки — `navigate`, «назад» в
   браузере возвращает прежнюю.
4. **Над вкладками** — только пояснение о ключе шифрования (`enabled ===
   false`): оно про пароли ручных прокси и адреса подписок сразу. **Под
   вкладками**, на всех — строка «Заводить, менять и проверять прокси может
   только владелец…» для тех, у кого нет `proxies.edit`.
5. **Вкладка рисует только свою панель.** Панели подписок, трафика и
   режимов грузят свои данные при монтировании. На вкладку не зашли — нет и
   запроса. Вернулись — панель перечитывает данные, как при открытии
   раздела. Список ручных прокси грузится, как сейчас, на уровне экрана:
   от него зависит пояснение о ключе.
6. **Место под «Ядро Xray».** Список вкладок — константа `PROXY_TABS`.
   Новая вкладка — строка в нём и ветка в `ProxiesScreen`. Задача
   «Ядра Xray» решит сама, где её место (по смыслу — после «Трафика»).

## Как сейчас

- `apps/admin/src/screens/proxies/ProxiesScreen.tsx` — после T-0384 и
  T-0386 одной лентой `flex flex-col gap-4`:
  - пояснение о ключе шифрования;
  - `<SubscriptionPanel canEdit={canEdit} />`;
  - `TrafficPanel` — его вставляет T-0386 «одной строкой под блоком
    подписок»; вызов (с пропсами, если они есть) переносится как есть;
  - `Panel title="Прокси"` со списком `ProxyCard`;
  - `<ModesPanel canEdit={canEdit} />`;
  - строка для тех, у кого нет `proxies.edit`;
  - `ProxyDialog`.

  Данные ручных прокси — `useApi(() => fetchProxies(api), [])` в начале
  экрана. Пока он грузится или упал, экран целиком показывает `Loading` /
  `ErrorNotice`.
- `apps/admin/src/screens/sections.tsx:46` — `proxies: () => <ProxiesScreen />`:
  `id` экран не получает. Вкладку экран читает сам — `useHashRoute()?.id`
  (`ui/router.ts`).
- `apps/admin/src/routes.ts` — `hrefOf({ section, id })` даёт `#/proxies/<id>`.
- Образец вкладок в адресе — `screens/players/PlayerCardView.tsx`
  (`cardTabOf`, `navigate`, `TabBar` после T-0410) и `card-rules.ts`
  (`CARD_TABS`, `cardTabOf`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`apps/admin/src/screens/proxies/proxies-tabs.ts`** (новый):

   ```ts
   /** Вкладки раздела «Прокси» (Р201): порядок — как панели стояли лентой. Новая вкладка — строка здесь и ветка в `ProxiesScreen`. */
   export const PROXY_TABS = [
     { id: "xray", title: "Подписки Xray" },
     { id: "traffic", title: "Трафик" },
     { id: "manual", title: "Ручные прокси" },
     { id: "modes", title: "Режимы" },
   ] as const;
   export type ProxyTab = (typeof PROXY_TABS)[number]["id"];
   export const DEFAULT_PROXY_TAB: ProxyTab = "xray";
   /** Вкладка из адреса; нет или чужая — «Подписки Xray». */
   export function proxyTabOf(id: string | null | undefined): ProxyTab;
   /** Маршрут вкладки: по умолчанию — без хвоста, `#/proxies`. */
   export function proxyTabRoute(tab: ProxyTab): Route; // { section: "proxies", id: tab === DEFAULT_PROXY_TAB ? null : tab }
   ```

3. **`ProxiesScreen.tsx`**:
   - `const tab = proxyTabOf(useHashRoute()?.id)`;
   - загрузка и ошибка списка ручных прокси — как сейчас;
   - дальше по порядку:
     - пояснение о ключе;
     - `<TabBar label="Прокси" tabs={PROXY_TABS} active={tab} onSelect={(next) => navigate(proxyTabRoute(next))} />`;
     - содержимое вкладки по решению 1;
     - строка для тех, у кого нет `proxies.edit`;
     - `ProxyDialog`.
   - Обработчики (`check`, `setEditing`, тосты) не меняются.
   - Панель ручных прокси — ветка `tab === "manual"`, разметка та же.
4. **Документы** — раздел «Документы».

## Чего не трогаем

- `SubscriptionPanel.tsx`, `SubscriptionCard.tsx`, `SubscriptionNodes.tsx`,
  `subscription-view.ts` (T-0384, T-0385), `TrafficPanel.tsx`,
  `traffic-view.ts` (T-0386), `ModesPanel.tsx`, `ProxyCard.tsx`,
  `ProxyDialog.tsx` — переносятся вызовом, без правки. `ProxyCard.tsx` и
  таблицу узлов правит T-0414 (флаги).
- `sections.tsx`, `routes.ts`, `ui/router.ts`, `ui/tab-bar.tsx`.
- Сервер и `api/*` — новых запросов нет.
- Вкладку «Ядро Xray» — её заводит отдельная задача.

## Сценарий и интерфейс

- **Открыли раздел из меню** → `#/proxies`, вкладка «Подписки Xray».
- **Вкладка «Режимы»** → адрес `#/proxies/modes`, ниже вкладок — только
  таблица режимов. «Назад» в браузере возвращает «Подписки Xray».
- **Ссылка `#/proxies/manual` из чата** открывает «Ручные прокси».
  `#/proxies/что-то` открывает «Подписки Xray».
- **Добавили или сохранили ручной прокси** → окно закрылось, список
  перечитан, вкладка та же.
- **Загрузка, ошибка, нет сети:**
  - списка ручных прокси — как сейчас, на весь экран (`Loading`,
    `ErrorNotice` с «Повторить»);
  - панелей подписок, трафика и режимов — их собственные, внутри
    вкладки.
- **Пусто** — тексты панелей как есть («Прокси нет — сервер ходит ко всем
  внешним API напрямую», «Подписки не подключены»…).
- **Без `proxies.edit`** — все четыре вкладки видны, кнопок правки нет,
  строка «Заводить, менять и проверять прокси может только владелец…» —
  под вкладками.
- **Телефон (390 px)** — строка вкладок прокручивается сама, страница без
  боковой прокрутки (`TabBar` это умеет).

Снимки (каждая вкладка на 390 и 1440 px) — в PR, если у потока есть
dev-сервер; иначе их делает тимлид на приёмке.

## Тесты

Первым коммитом.

- `apps/admin/test/proxies-tabs.test.ts`:
  - `PROXY_TABS.map((tab) => tab.id)` → `["xray", "traffic", "manual", "modes"]`;
    названия — из решения 1;
  - `proxyTabOf(undefined)`, `proxyTabOf(null)`, `proxyTabOf("")`,
    `proxyTabOf("nope")` → `"xray"`; `proxyTabOf("modes")` → `"modes"`;
  - `hrefOf(proxyTabRoute("xray"))` → `#/proxies`;
    `hrefOf(proxyTabRoute("manual"))` → `#/proxies/manual`;
  - `proxyTabOf(parseRoute("#/proxies/traffic")?.id)` → `"traffic"`:
    адрес туда и обратно.
- Существующие `proxies.test.ts`, `proxy-subscription.test.ts`,
  `proxy-traffic.test.ts`, `routes.test.ts` зелёные без правки.

## Аналитика

Нет: интерфейс панели.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md`, строка «Прокси» в таблице модулей. В начало
  описания: «Вкладки с адресом `#/proxies/<вкладка>` (Р201, T-0411):
  «Подписки Xray» (по умолчанию), «Трафик», «Ручные прокси», «Режимы»;
  пояснение о ключе шифрования — над вкладками». Фразы «Ниже — режимы
  сервисов» и «Блок «Подписка Xray» над списком» переписать под вкладки,
  остальной текст не трогать.

## Критерии приёмки

- [ ] Четыре вкладки в порядке решения 1, вкладка — в адресе, «назад»
  работает, неизвестный хвост открывает «Подписки Xray».
- [ ] На каждой вкладке — ровно та панель, что раньше стояла в ленте, без
  правки её файла.
- [ ] Пояснение о ключе — над вкладками, строка для тех, у кого нет
  `proxies.edit`, — под ними.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Вкладки в разделе «Прокси»`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВКЛАДКИ В РАЗДЕЛЕ «ПРОКСИ»**

  Раздел «Прокси» в панели разложен по вкладкам вместо одной длинной ленты. Ссылку на нужную вкладку можно отправить, «назад» в браузере работает.

  🛠 **Вкладки**

  • «Подписки Xray» — подписки и их узлы (открывается первой)
  • «Трафик» — сколько прошло через узлы
  • «Ручные прокси» — прокси, заведённые руками
  • «Режимы» — как каждый сервис ходит наружу
  ```
