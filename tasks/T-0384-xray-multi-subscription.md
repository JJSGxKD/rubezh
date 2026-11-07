---
id: T-0384
title: Пул Xray — несколько подписок в общем переборе
epic: E13
priority: P2
status: ready
owner:
author: claude-lead2-4
size: M
depends_on: []
zones:
  - backend/api/src/modules/proxies/subscription/**
  - backend/api/src/modules/proxies/proxies.module.ts
  - backend/api/src/modules/proxies/proxies-errors.ts
  - backend/api/src/modules/admin/admin-proxy-subscription.controller.ts
  - backend/api/test/proxy-subscription.test.ts
  - backend/api/test/proxy-subscription.integration.test.ts
  - backend/api/test/proxy-subscriptions-multi.test.ts
  - backend/api/test/helpers/memory-subscription.ts
  - packages/proxy-kit/src/xray-config.ts
  - packages/proxy-kit/src/pool.ts
  - packages/proxy-kit/src/node-schema.ts
  - packages/proxy-kit/test/xray-config.test.ts
  - packages/proxy-kit/test/pool.test.ts
  - packages/proxy-kit/test/node-schema.test.ts
  - packages/proxy-kit/test/fixtures/xray/**
  - apps/admin/src/api/proxy-subscription.ts
  - apps/admin/src/screens/proxies/SubscriptionPanel.tsx
  - apps/admin/src/screens/proxies/SubscriptionCard.tsx
  - apps/admin/src/screens/proxies/SubscriptionNodes.tsx
  - apps/admin/src/screens/proxies/SubscriptionDialog.tsx
  - apps/admin/src/screens/proxies/subscription-view.ts
  - apps/admin/test/proxy-subscription.test.ts
shared:
  - packages/proxy-kit/src/index.ts
  - packages/proxy-kit/README.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - apps/admin/src/ui/help.ts
  - docs/20-env-and-ports.md
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 5
---

# T-0384. Пул Xray — несколько подписок в общем переборе

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0384.json)](README.md#значки-статуса)

## Зачем

Сейчас к прокси исходящих запросов подключается одна подписка Xray (строка
`main`). Владелец решил (Р192): подписок в пуле несколько, узлы всех подписок
идут в **общий** перебор так же, как сейчас (живой, с меньшей задержкой), а
подписку можно выключить целиком. После задачи в разделе «Прокси» — список
подписок, у каждой свои кнопки «Обновить сейчас», «Проверить узлы», «Изменить»,
«Отключить», «Удалить».

## Решения

- **Р192** (`docs/35-stage4-plan.md`): несколько подписок, общий перебор, выключение
  подписки целиком. Снимает «одна подписка на систему» из Р101 и T-0093.
- **Р101, Р91** — всё остальное не меняется: адрес шифртекстом `SecretCipher`, назад
  не показывается; узел — `socks5://xray:<база + слот>` без пароля; в перебор идут
  `proxy.subscription.candidates` лучших здоровых узлов **на всю систему** после
  ручных прокси; сбой поставщика не обнуляет рабочие узлы; права `proxies.view` и
  `proxies.edit`, новых нет.

Решения этой спецификации (`claude-lead2-4`, 07.11.2026, в рамках Р192):

- **Ключ подписки неизменен с рождения.** Существующая строка остаётся с ключом
  `main`. От ключа зависят две вещи: имя шифртекста адреса
  (`proxy_subscription:<ключ>` подписан вместе с данными, `subscription-url.ts`) и
  `x-hwid` (`subscriptionHwid(cipher, key)`, `subscription-download.ts`). Смена ключа
  сделала бы адрес нечитаемым и заняла бы у поставщика новое устройство. Новые
  подписки получают ключ из 12 строчных hex (`randomBytes(6).toString("hex")`).
- **Не больше 10 подписок.** Число — из ресурсов спутника: входов (`XRAY_SLOT_COUNT`)
  по умолчанию 100, и при 10 подписках на каждую приходится не меньше 10 узлов —
  ниже этого подписка в переборе почти ничего не добавляет. Обновление идёт под
  одним замком со сроком 120 с, загрузка подписки — до 15 с: за тик успевают
  несколько подписок, а 10 обходятся за пару минут. Константа `SUBSCRIPTIONS_MAX = 10`
  в `subscription-rules.ts`; поднять её — правка кода, не панели.
- **Входы делятся поровну.** Доля подписки — `floor(XRAY_SLOT_COUNT / число подписок)`,
  считаются все подписки, и выключенные: выключение не отдаёт входы другим, поэтому
  включение назад мгновенное, без загрузки. Узлы сверх доли — в итоге обновления
  («Не хватило входов…»), как сейчас при переполнении.
- **Конфиг Xray — один файл, собранный из частей подписок.** Секретов узлов (UUID,
  пароль) в базе нет и не будет: они только в конфиге и в ответе поставщика. Чтобы
  обновление одной подписки не теряло узлы остальных, API хранит узлы каждой
  подписки отдельным файлом-частью в том же томе (`<каталог конфига>/subscriptions/<ключ>.json`,
  права `0600`: Xray её не читает) и собирает `config.json` из частей **включённых**
  подписок. Уровень доверия тот же, что у `config.json`: том подключён только к API
  и Xray. Часть читается Zod-схемой (данные с диска — граница системы).
- **Тег выхода — с ключом подписки:** `out-<ключ подписки>-<ключ узла>`. Один и тот же
  узел может прийти из двух подписок; ключ узла сам по себе больше не уникален. По
  тегу T-0386 будет относить трафик к узлу и подписке.
- **Узел в пуле и в журнале** — `<ключ подписки>:<ключ узла>`; в журнале запросов
  `via = node:<ключ подписки>:<ключ узла>` (до 38 знаков, колонка `VarChar(40)`).
- **Фильтр стран — у каждой подписки свой**, как сейчас; общий выбор лучших идёт по
  узлам, прошедшим фильтр своей подписки.
- **Всё, что меняет конфиг, — под общим замком** `proxy-subscription:refresh:lock`:
  обновление, сборка, создание, включение и выключение, удаление. Замок занят —
  `SubscriptionBusyError` (409), правка в базу не пишется.
- **Кнопки «не чаще раза в минуту» — у каждой подписки свои**:
  `proxy-subscription:manual:refresh:<ключ>`, `…:probe:<ключ>`.

## Как сейчас

- **Схема** `backend/api/prisma/schema.prisma` ~2257–2310: `ProxySubscription` (`key`
  `VarChar(16)` PK, адрес — `urlIv/urlTag/urlCt/urlKeyId/urlHint`, `enabled`,
  `countries`, итог, трафик поставщика, срок) и `ProxySubscriptionNode` (PK
  `(subscription_key, node_key)`, `slot @unique` — уже глобально уникален, каскад от
  подписки). Миграция `20261102130000_proxy_subscription`: `CHECK ("key" = 'main')`.
- **Репозиторий** `subscription/subscription.repository.ts`: `SUBSCRIPTION_KEY = "main"`;
  `load()` читает одну строку; `save`, `applyRefresh(key)`, `recordFailure(key)`,
  `saveProbes(key)`, `scheduleAllProbes(key)`, `remove(key)`.
- **Обновление** `subscription.sync.ts`: замок → адрес и HWID → `loadSubscription` →
  `parseSubscription` → `assignSlots(ключи, прежние слоты, slotCount)` →
  `buildXrayConfig(placed, slots, …)` → `writer.write` → `applyRefresh` →
  `routes.reload()`. Ошибка до записи конфига — `recordFailure`, узлы и конфиг прежние.
- **Расписание** `subscription.scheduler.ts`: тик 30 с, `refreshDue`, `configMissing`,
  проверки `routes.due` (25 за тик, по 5) под тем же замком, `saveProbes(SUBSCRIPTION_KEY, …)`.
- **Перебор** `subscription-routes.ts`: пул `NodePool` по `nodeKey`, `list(afterPriority)` —
  `candidates` лучших с фильтром стран одной подписки, id `node:<ключ>`.
  `proxy-routes.service.ts` склеивает ручные прокси и `subscription.list(...)` — не меняется.
- **Сервис** `subscription.service.ts`: `view`, `save` (создание и правка одной строки),
  `refresh`, `probe`, `remove` (пишет пустой конфиг **без замка**), аудит
  `proxy_subscription.save|toggle|refresh|probe|delete`, `target: "main"`.
- **Контроллер** `admin/admin-proxy-subscription.controller.ts`: `/api/v1/admin/proxy-subscription`
  — `GET`, `PUT`, `DELETE` корня, `POST refresh`, `POST probe`.
- **Конфиг** `packages/proxy-kit/src/xray-config.ts`: `assignSlots(keys, previous, slotCount)`,
  `buildXrayConfig(nodes, slots, options)`, тег выхода `out-<ключ узла>`, золотые файлы
  `test/fixtures/xray/*.json` с `out-{{KEY}}`. Пул — `src/pool.ts`, `pick({ countries, limit })`.
- **Запись** `xray-config-writer.ts`: `FileConfigWriter` — временный файл и `rename`, `0644`.
- **Панель** `apps/admin/src/screens/proxies/SubscriptionPanel.tsx` (блок, карточка и
  таблица узлов в одном файле), `SubscriptionDialog.tsx`, `subscription-view.ts`;
  клиент `apps/admin/src/api/proxy-subscription.ts` (`fetchSubscription` и т. д.).
- **Ошибки запросов в панели** — так, как в `dev` на день работы: T-0374 (пачка 4) заводит
  `toastError(error)` и строку подробностей в `ErrorNotice`. Влита — новые компоненты
  зовут её, а не `toast.error(result.error.message)`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** — после перебазирования на свежий `dev`, без базы, по строке
   «миграции» в `tasks/README.md`, «Общие файлы». В `schema.prisma` у `ProxySubscription`:

   ```prisma
   /// когда подключена: порядок карточек в панели
   createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
   ```

   Комментарий модели: «Несколько подписок (Р192): ключ неизменен с рождения — от него
   зависят шифртекст адреса и x-hwid; первая подписка сохранила ключ `main`». В
   `migration.sql` после строк, которые дал `prisma migrate diff`, руками:

   ```sql
   -- Несколько подписок (Р192): ключ — строчные латиница и цифры, как его выдаёт API.
   ALTER TABLE "proxy_subscription" DROP CONSTRAINT "proxy_subscription_key_check";
   ALTER TABLE "proxy_subscription"
     ADD CONSTRAINT "proxy_subscription_key_check" CHECK ("key" ~ '^[a-z0-9]{1,16}$');
   ```

   Данные не переносятся: строка `main` и её узлы остаются как есть. Новой модели нет —
   `wipe-plan.ts` не трогается.
3. **`packages/proxy-kit/src/node-schema.ts`** — `proxyNodeSchema` (Zod) ровно по типу
   `ProxyNode` из `node.ts` (тип выводится проверкой `satisfies z.ZodType<ProxyNode>`),
   экспорт из `index.ts`. Им API читает файлы-части.
4. **`packages/proxy-kit/src/xray-config.ts`:**
   - `export interface PlacedNode { group: string; node: ProxyNode; slot: number }` —
     `group` — ключ подписки, `^[a-z0-9]{1,16}$`;
   - `export const outboundTag = (group: string, key: string): string => \`out-${group}-${key}\``
     (в таблицу `F` вместо `tagOut`);
   - `buildXrayConfig(placed: readonly PlacedNode[], options: XrayConfigOptions)` вместо
     `(nodes, slots, options)`: группа не по формату, повтор слота, слот вне диапазона —
     `RangeError`; остальное поведение то же (выход `block` первым, правило «вход → свой
     выход», сортировка по слоту);
   - `assignSlots(keys, previous, options: { slotCount: number; reserved: ReadonlySet<number>; limit: number })`:
     `reserved` — слоты узлов других подписок (их не брать), `limit` — доля подписки;
     прежний слот сохраняется, если он не в `reserved` и узлов с сохранёнными слотами
     ещё меньше `limit`; новым — наименьшие свободные; не поместившиеся — `overflow`;
   - золотые файлы `test/fixtures/xray/*.json`: тег `out-{{KEY}}` → `out-main-{{KEY}}`
     (подстановку `{{KEY}}` в `check-config.sh` это не трогает).
5. **`packages/proxy-kit/src/pool.ts`:** в `pick` — необязательный
   `accept?: (entry: PoolEntry) => boolean`, применяется вместе с `countries`.
6. **`subscription/subscription-rules.ts`** (новый): `SUBSCRIPTIONS_MAX = 10`,
   `newSubscriptionKey()`, `SUBSCRIPTION_KEY_FORMAT = /^[a-z0-9]{1,16}$/`,
   `slotQuota(slotCount, subscriptions) = Math.floor(slotCount / Math.max(1, subscriptions))`,
   `nodeRef(subscriptionKey, nodeKey) = \`${subscriptionKey}:${nodeKey}\``,
   `trimToQuota(nodes, quota)` — какие узлы снять, если их больше доли: сначала
   `down`, затем `unknown`, затем с большей задержкой, при равенстве — с большим слотом.
7. **Репозиторий** (`subscription.repository.ts`): убрать `SUBSCRIPTION_KEY` из
   публичного API (оставить константу `LEGACY_SUBSCRIPTION_KEY = "main"` только для
   комментария и теста миграции). Методы: `list(): Promise<SubscriptionSnapshot[]>`
   (по `createdAt`, узлы по слоту), `load(key)`, `count()`, `create(row)`,
   `save(row, { dropNodes })`, `applyRefresh(key, write)`, `recordFailure(key, …)`,
   `saveProbes(key, …)`, `scheduleAllProbes(key, at)`, `dropNodes(key, nodeKeys)` (снять
   узлы сверх доли), `remove(key)`. `MemorySubscriptionRepository` в
   `test/helpers/memory-subscription.ts` — так же, со списком подписок.
8. **Части конфига** — `xray-config-writer.ts`: в порт `ConfigWriter` добавить
   `writePart(key, part)`, `readPart(key): Promise<ConfigPart | null>` (нет файла или
   не прошёл схему — `null`), `removePart(key)`. `ConfigPart = { version: 1; nodes: { node: ProxyNode; slot: number }[] }`,
   схема — на `proxyNodeSchema`. Файл — `<dirname(XRAY_CONFIG_PATH)>/subscriptions/<ключ>.json`,
   каталог создаётся `0700`, файл `0600`, запись так же атомарно (временный файл и
   `rename`). Нет каталога тома — `SidecarMissingError`, как у `write`.
9. **Сборка конфига** — `subscription/xray-config-assembly.ts` (новый, его же правит
   T-0386): `assembleConfig(deps, override?: { key: string; part: ConfigPart })` —
   читает части всех **включённых** подписок (для `override.key` берёт переданную
   часть, а не файл), собирает `buildXrayConfig` с `group = ключ подписки` и пишет
   `config.json`. Возвращает ключи включённых подписок, чьей части нет или она не
   читается: их узлы в конфиг не попали, расписание обновит такие подписки сразу
   (шаг 11).
10. **Обновление** (`subscription.sync.ts`): `refresh(key, now)` — под замком;
    подписки нет — `absent`, выключена — `disabled`. Слоты: `reserved` — слоты узлов
    остальных подписок из базы, `limit` — `slotQuota(slotCount, count())`. Порядок
    записи: часть подписки → сборка `config.json` → транзакция `applyRefresh` →
    `routes.reload()` → `changed()`. Ошибка до записи части — как сейчас
    (`recordFailure`, всё прежнее). Ошибка записи части или конфига — `recordFailure`
    с `NOTES.writeFailed` либо `NOTES.noSidecar`; следующий удачный проход всё
    сводит. Переполнение — новая заметка `overflowNote(count, quota)`:
    «Не хватило входов: N узлов не подключены — на подписку приходится M входов;
    увеличьте XRAY_SLOT_COUNT или удалите лишние подписки». Отдельный метод
    `rebuild(now)` — сборка без загрузки (для создания, включения, удаления, обрезки
    по доле и пропавшего `config.json`).
11. **Расписание** (`subscription.scheduler.ts`): на тике — `routes.reload()`;
    `config.json` нет, а каталог есть — `rebuild`; подписки, у которых нет части
    (итог `assembleConfig`) или которым пора по `refreshDue`, обновляются по одной
    по порядку «дольше всех ждёт», **не больше 3 за тик** (3 × 15 с загрузки
    укладываются в замок 120 с), выключенные — никогда. Проверки узлов — как сейчас,
    но `saveProbes` группирует записи по ключу подписки. Первый тик после выкатки
    найдёт `config.json` и не найдёт часть `main` — `main` обновится сразу; это
    ожидаемо и записывается в описание PR.
12. **Перебор** (`subscription-routes.ts`): пул по `nodeRef`; `entryOf` берёт ref;
    `list(afterPriority)` — `pick({ limit: candidates, accept })`, где `accept`
    пропускает узел, если его подписка включена и узел проходит фильтр стран своей
    подписки (пусто — любые; узел без страны при фильтре не идёт, как сейчас); id
    `node:<ключ подписки>:<ключ узла>`. `connectionOf(ref)`, `record(ref, …)`,
    `probeWrites(refs)` → записи с ключом подписки. `current()` убрать, если он
    нигде не используется (сейчас — нигде вне файла).
13. **Сервис** (`subscription.service.ts`, держать < 300 строк — выдели
    `subscription-commands.ts`, если не влезает):
    - `list(actor)` — обзор (шаг 15);
    - `create(actor, input)` — `count() >= SUBSCRIPTIONS_MAX` → `SubscriptionLimitError`;
      адрес обязателен; ключ — `newSubscriptionKey()`; под замком: запись строки,
      обрезка остальных по новой доле (`trimToQuota` → `dropNodes` → часть
      переписывается без снятых узлов), `rebuild`; аудит `proxy_subscription.save` с
      `target: <ключ>`;
    - `update(actor, key, input)` — как нынешний `save`, но по ключу; смена адреса —
      `dropNodes` всех узлов, `removePart(key)`, сброс итога (как сейчас); смена
      `enabled` — под замком `rebuild`, аудит `proxy_subscription.toggle`;
    - `refresh(actor, key)`, `probe(actor, key)` — как сейчас, по ключу, метки минуты свои;
    - `remove(actor, key)` — под замком: `removePart`, удаление строки (узлы каскадом),
      `rebuild`; пустой список подписок даёт конфиг без входов, как сейчас;
    - все действия: нет подписки — `SubscriptionNotFoundError`; аудит без адреса, с
      названием и подсказкой; затем `proxyRoutes.changed("subscription")`.
14. **Ошибки** (`proxies-errors.ts`): `SubscriptionLimitError` — 409,
    `proxy_subscription_limit`, «Подписок уже 10 — удалите лишнюю, чтобы добавить
    новую». Текст `SubscriptionBusyError` — «Подписки сейчас обновляются на сервере —
    повторите через минуту».
15. **Контроллер** — тот же файл `admin-proxy-subscription.controller.ts`, путь
    `admin/proxy-subscriptions`: `GET /` (обзор), `POST /` (создать; `name`, `url`
    обязателен, `countries`, `enabled`), `PUT /:key` (`url` необязателен — нет =
    прежний), `DELETE /:key`, `POST /:key/refresh`, `POST /:key/probe`. `:key` —
    Zod `SUBSCRIPTION_KEY_FORMAT`, иначе 400. Права и лимит `ADMIN_LIMITS.mutate` —
    как сейчас. Старого пути `admin/proxy-subscription` больше нет: панель и API
    выходят одним релизом. Обзор:

    ```ts
    interface SubscriptionsOverview {
      encryption: boolean;
      sidecar: { connected: boolean };
      limit: number;          // SUBSCRIPTIONS_MAX
      slotCount: number;      // XRAY_SLOT_COUNT
      slotQuota: number;      // доля одной подписки сейчас
      subscriptions: (SubscriptionView & { key: string; nodes: NodeView[] })[];
    }
    ```
16. **Панель:**
    - `api/proxy-subscription.ts` — схемы под обзор выше; `fetchSubscriptions`,
      `createSubscription`, `updateSubscription(key, form)`, `refreshSubscription(key)`,
      `probeSubscription(key)`, `deleteSubscription(key)`;
    - `SubscriptionPanel.tsx` — блок «Подписки Xray» со списком; карточка подписки —
      `SubscriptionCard.tsx`, таблица узлов — `SubscriptionNodes.tsx` (эти имена
      правят T-0385 и T-0386, не меняй их);
    - `subscription-view.ts` — `nodesSummary(nodes)` («37 узлов: работают 30, не
      отвечают 5, не проверены 2»), `slotLine(overview)` («Входов Xray: 100, на
      подписку — 50»); прочие функции — как есть;
    - пояснение `HELP.proxies.subscription` — переписать под несколько подписок
      (текст — раздел «Сценарий»).
17. **Документы** — раздел «Документы».

## Чего не трогаем

- Разбор подписки и ссылок, загрузку, `x-hwid`, тексты причин пропуска — кроме
  шага 4 в `xray-config.ts` и шага 5 в `pool.ts` (транспорт, маршрутизация и
  устройство — T-0385, пропуски парсера — T-0387).
- `proxy-routes.service.ts`, ручные прокси, режимы сервисов, клиент исходящих.
- Учёт трафика и блоки `stats`/`api`/`policy` конфига — T-0386.
- `infra/prod/**`: контейнер, `run.sh` и `compose.yml` не меняются — спутник читает
  тот же `config.json`. Файлы-части лежат рядом, Xray их не открывает.
- Ключи `setting-catalog.ts`: `candidates` остаётся одним на систему.

## Сценарий и интерфейс

Блок «Подписки Xray» над списком прокси. Пояснение под заголовком: «Адреса подписок
с множеством подключений. Узлы всех включённых подписок — общий запас прокси для
запросов сервера к внешним API: в перебор идут лучшие по задержке».

- **Загрузка, нет сети, ошибка** — как сейчас.
- **Пусто** — «Подписки не подключены», кнопка «Добавить подписку». Без ключа
  шифрования — прежнее пояснение вместо кнопки.
- **Шапка блока** — кнопки «Обновить» (перечитать раздел) и «Добавить подписку»;
  под пояснением — `slotLine`. Подписок 10 — кнопки нет, строка «Подписок 10 —
  больше добавить нельзя: удалите лишнюю».
- **Карточка подписки** (`SubscriptionCard`, по `createdAt`): всё, что сейчас
  (название, «Включена»/«Выключена», подсказка адреса, итог, трафик и срок, страны,
  кнопки), плюс строка `nodesSummary`. Таблица узлов (`SubscriptionNodes`) —
  колонки как сейчас; раскрыта, если подписка одна, иначе свёрнута кнопкой
  «Показать узлы (37)» / «Скрыть узлы».
- **Выключенная подписка** — бейдж «Выключена», строка «Узлы не в переборе; входы
  Xray за подпиской сохранены».
- **Диалог** — как сейчас; заголовок «Новая подписка» / «Подписка: <название>».
  Тост после создания — «Подписка добавлена»; описание — «Список узлов появится в
  течение минуты — или нажмите «Обновить сейчас»».
- **Удаление** — подтверждение как сейчас: «Узлов в переборе: 37 → 0».
- **Замок занят** — тост с текстом `SubscriptionBusyError`.
- **Ограничение аккаунта** — без `proxies.edit` кнопки скрыты, список виден.

Текст `HELP.proxies.subscription`: «Подписок может быть до десяти. Узлы всех
включённых подписок — один общий запас: в перебор после ручных прокси идут лучшие
по задержке. У каждой подписки свой фильтр стран. Входы Xray делятся между
подписками поровну, выключенная подписка свои входы сохраняет. Адрес подписки
секретный: после сохранения он не показывается».

## Тесты

Первым коммитом. Существующие тесты `proxy-subscription.test.ts` и
`.integration.test.ts` переводятся на ключ подписки, их ожидания не ослабляются.

- **`packages/proxy-kit/test/xray-config.test.ts`:**
  - две группы с одинаковым ключом узла → два выхода `out-a-<key>` и `out-b-<key>`,
    два входа, правила «вход → свой выход»;
  - повтор слота, слот вне диапазона, группа `Main` или длиннее 16 → `RangeError`;
  - `assignSlots`: прежний слот из `reserved` не берётся; новый — наименьший свободный
    вне `reserved`; `limit = 2` при трёх узлах → два слота и один в `overflow`; прежние
    слоты в пределах доли сохраняются;
  - золотые файлы совпадают после замены тега.
- **`packages/proxy-kit/test/pool.test.ts`** — `pick` с `accept`: отвергнутый здоровый
  быстрый узел не выбирается; `accept` и `countries` вместе.
- **`packages/proxy-kit/test/node-schema.test.ts`** — узел из `parseShareLink` проходит
  схему; лишнее поле, неизвестный `network`, `security.kind = "x"` — отказ.
- **`backend/api/test/proxy-subscriptions-multi.test.ts`** (подмены: `fetch`, DNS,
  `ConfigWriter` в памяти с частями, репозиторий, часы, Redis):
  - две подписки по три узла → `config.json` из шести входов, теги с ключами подписок;
    `list()` даёт не больше `candidates` лучших из обеих;
  - обновление подписки A с ошибкой поставщика → узлы и часть B в конфиге на месте,
    у A прежние узлы;
  - одинаковый узел в A и B — два слота, два выхода, в переборе ref различаются;
  - выключение A → в конфиге только B, строки узлов A в базе остались со слотами;
    включение → A снова в конфиге **без** запроса к поставщику;
  - фильтр стран A (`DE`) не действует на узлы B;
  - доля: `XRAY_SLOT_COUNT = 4`, у A 4 узла, создание B → у A остаются 2 (сняты
    `down`, затем с большей задержкой), часть A переписана, B получает до 2;
  - 11-я подписка → `SubscriptionLimitError`, строка не записана;
  - замок занят → `create`, `update` с `enabled`, `remove` отвечают
    `SubscriptionBusyError`, база не изменена;
  - удаление A → часть A удалена, узлы каскадом, B в конфиге;
  - нет `config.json`, части есть → тик пересобирает без загрузки; нет части
    включённой подписки → тик её обновляет; за тик обновляется не больше трёх;
  - часть с испорченным JSON или не по схеме → `readPart` даёт `null`, подписка
    обновляется на тике, текст ошибки без секретов;
  - метки минуты у кнопок по подпискам: «Обновить» A и сразу B — оба проходят,
    A дважды — второй 429;
  - `via` в журнале — `node:<ключ подписки>:<ключ узла>`;
  - контроллер: `:key` `ABC` или 17 знаков → 400; без `proxies.edit` — 403; ответы и
    аудит без адреса; `target` аудита — ключ подписки.
- **`backend/api/test/proxy-subscription.integration.test.ts`** (Postgres, Redis):
  после миграции строка `main` с узлами читается, её адрес открывается тем же ключом;
  вставка подписки с ключом `ABC` нарушает CHECK; `slot` уникален между подписками;
  удаление подписки каскадом убирает только её узлы.
- **`apps/admin/test/proxy-subscription.test.ts`** — `nodesSummary`, `slotLine`, разбор
  обзора схемой (несколько подписок, пустой список).

## Аналитика

Нет: игрок раздела не видит; действия — в аудите панели, обращения через узлы — в
журнале запросов (T-0060).

## Настройки и окружение

Новых ключей и переменных нет. `XRAY_SLOT_COUNT` теперь делится между подписками —
отметить в `docs/20` и `docs/30`.

## Документы

- **`docs/29-admin-panel.md`**, строка «Прокси»: «Блок «Подписка Xray» … одна подписка
  на систему» → «Блок «Подписки Xray» (Р101, Р192, `tasks/T-0093`, `tasks/T-0384`): до
  десяти подписок…» — общий перебор, своя у каждой подписки кнопка и фильтр стран,
  выключение целиком, доля входов, свёрнутые узлы. Остальной текст строки не
  переписывать.
- **`docs/30-configuration-map.md`**: строка подписки — «несколько подписок, до 10
  (`SUBSCRIPTIONS_MAX` в `subscription-rules.ts`), входы делятся поровну»; строка
  `XRAY_*` — то же про `XRAY_SLOT_COUNT`; строка контейнера — части конфига
  `subscriptions/<ключ>.json` в томе.
- **`docs/20-env-and-ports.md`**: в описании `XRAY_SLOT_COUNT` (§7, «9.3») — «на все
  подписки»; в разделе про спутник — «API собирает `config.json` из частей
  подписок; пропал `config.json` — пересоберётся на следующем тике без запроса к
  поставщикам».
- **`packages/proxy-kit/README.md`** — пример под новые `buildXrayConfig(placed, options)`
  и `assignSlots(keys, previous, { slotCount, reserved, limit })`, тег с группой.
- **`docs/21-diagrams.md`**: ER — `proxy_subscription.created_at`, ключ не только
  `main`; поток подписки — части подписок → сборка → `config.json`.

## Критерии приёмки

- [ ] Можно подключить до 10 подписок; 11-я — понятный отказ.
- [ ] Узлы всех включённых подписок — в общем переборе, лучшие по задержке, с фильтром
      стран своей подписки; выключенная подписка в переборе не участвует.
- [ ] Обновление и сбой одной подписки не трогают узлы других в конфиге Xray.
- [ ] Существующая подписка после выкатки работает без повторного ввода адреса
      (ключ `main`, тот же `x-hwid`).
- [ ] Входы делятся по доле; переполнение — в итоге подписки.
- [ ] Всё, что меняет конфиг, идёт под замком; адреса нет ни в ответах, ни в аудите,
      ни в логах.
- [ ] В описании PR — план отката (раздел «PR»).
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Несколько подписок Xray в пуле прокси`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **План отката** — раздел `## Откат` в описании PR, дословно с проверенными командами:
  1. В панели удалить все подписки, кроме исходной (ключ `main`), — или SQL
     `DELETE FROM proxy_subscription WHERE key <> 'main';` (узлы уходят каскадом).
     Без этого прежний код упрётся в уникальность `slot`: слоты чужих узлов он не видит.
  2. Откатить миграцию: `ALTER TABLE proxy_subscription DROP CONSTRAINT proxy_subscription_key_check;`
     `ALTER TABLE proxy_subscription ADD CONSTRAINT proxy_subscription_key_check CHECK (key = 'main');`
     `ALTER TABLE proxy_subscription DROP COLUMN created_at;` и удалить строку миграции из
     `_prisma_migrations`.
  3. Выкатить прежний релиз. Каталог `subscriptions/` в томе прежний код не читает;
     `config.json` он перепишет при первом обновлении `main`.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НЕСКОЛЬКО ПОДПИСОК XRAY**

  В разделе «Прокси» теперь можно подключить до десяти подписок Xray. Узлы всех включённых подписок — общий запас прокси: в перебор идут лучшие по задержке. Подписку можно выключить целиком.

  🛠 **Эксплуатация**

  • входы Xray (XRAY_SLOT_COUNT) делятся между подписками поровну
  • после выкатки существующая подписка один раз обновится сама — адрес вводить заново не нужно
  • сбой одной подписки не трогает узлы остальных

  ❓ **Нужно от команды**

  • @владелец — после выкатки проверить, что прежняя подписка в разделе «Прокси» обновилась и узлы «Работают»
  ```

## Вопросы к тимлиду

Неблокирующие: спецификация написана по варианту «(Рекомендуется)»; другой ответ —
правка спецификации до захвата.

1. **Предел числа подписок.** (а) 10, из ресурсов спутника (Рекомендуется); (б) 5;
   (в) ключ панели `proxy.subscription.max`.
2. **Доля входов у выключенной подписки.** (а) Сохраняется — включение мгновенное
   (Рекомендуется); (б) отдаётся включённым, при включении нужна загрузка.
