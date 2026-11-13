---
id: T-0453
title: Кабинет участника «Мой проект» — выручка месяца, холд и черновик части (сервер)
epic: E15
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0452]
zones:
  - backend/api/src/modules/stakeholders/project-month.ts
  - backend/api/src/modules/stakeholders/project-month.repository.ts
  - backend/api/src/modules/stakeholders/project-month.service.ts
  - backend/api/src/modules/admin/admin-my-project.controller.ts
  - backend/api/test/project-month.test.ts
  - backend/api/test/project-month.integration.test.ts
  - backend/api/test/admin-my-project.http.test.ts
  - packages/fx/src/refresh.ts
  - packages/fx/test/refresh.test.ts
  - backend/api/src/modules/fx/fx.service.ts
shared:
  - backend/api/src/modules/stakeholders/stakeholders.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/test/route-permissions.test.ts
  - docs/30-configuration-map.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0453. Кабинет участника «Мой проект» — выручка месяца, холд и черновик части (сервер)

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0453.json)](README.md#значки-статуса) [![T-0452](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0452.json&label=T-0452)](T-0452-stakeholder-shares-server.md)

## Зачем

Участник проекта сейчас не видит ни одной цифры проекта. Ядра учёта ещё нет
(`docs/37-accounting.md`), но выручку звёздами, возвраты и холд можно честно
посчитать по живым покупкам. Задача отдаёт кабинету участника месяц проекта:
долю, участников, выручку по площадкам и источникам в ⭐, $ и ₽, холд и
черновик своей части с явной пометкой, что это до расходов и налога. Экран —
T-0455.

## Решения

- `docs/35-stage4-plan.md`, **Р218** (ответ владельца 13.11.2026), и **Р217**
  (доли, T-0452).
- **О45 закрыт**: доллар — основная валюта отчёта, рубль — рядом.
- Выручка месяца — живые оплаты (`purchase.mode = 'live'`) с `paid_at` в
  месяце по UTC; **возвращённые из них вычитаются** (возврат когда угодно —
  оплата месяца уже не наша). Тестовые оплаты (`mode = 'test'`) не входят.
- Площадка — площадка аккаунта покупателя (`account.platform`); источник —
  по виду покупки: `shop_item` → «Магазин», `continue_run` → «Второй шанс»,
  `vip` → «VIP», `donation` → «Донаты».
- Холд — `paid_at + N дней`, `N` — настройка «Холд оплаты звёздами, дней»
  (`payments.hold-days.telegram`, 21, 0…90) в группе «Платежи». Звёзды — пока
  единственный способ оплаты; ключ назван по площадке, чтобы у MAX и VK были
  свои.
- Курсы: звезда → доллар по **курсу выплаты** XTR (`payout` в снимке курсов —
  по нему считается выручка), доллар → рубль по курсу рубля. Курс текущий
  и для прошлых месяцев: это черновик; в ответе — дата курса. Нет курса
  выплаты звезды — денежных сумм нет (`rates: null`), только звёзды.
- Черновик части = чистая выручка месяца × доля смотрящего, в $ и ₽, с
  округлением до цента и копейки **вниз** (не обещать больше, чем есть).
- Смотрящий: участник (`revenue.split.own.view`) — его доля на месяц;
  владелец — остаток после участников; финансы без доли — `share: null`,
  черновика нет.

## Как сейчас

- Покупки — `model Purchase` в `schema.prisma`: `charged_stars`, `mode`,
  `status`, `paid_at`, `refunded_at`, `product`, `account_id`; индекс
  `@@index([mode, paidAt])` — под выручку.
- Пример запроса выручки — `admin/admin-all-time.repository.ts`, `revenue()`
  (строка ~131): `FILTER (WHERE paid_at IS NOT NULL)`, `mode = 'live'`,
  разбор строк Zod-схемой.
- Курсы — `FxService.snapshot(now)` (`modules/fx/fx.service.ts`, строка ~342)
  вызывает `takeSnapshot` (`packages/fx/src/refresh.ts`, строка ~110), а
  тот **сохраняет снимок** (`store.saveSnapshot`) — на каждый просмотр
  кабинета писать строку в базу нельзя.
- Настройки: `integer(key, group, title, description, { min, max, unit }, default)`
  в `modules/settings/setting-catalog.ts` (пример — `paymentsCompensationMultiplier`,
  группа `PAYMENTS_GROUP`); чтение — `settings.get(SETTINGS.<имя>)`
  (`payments/purchase-compensation.ts`, строка ~126).
- Доли — `StakeholdersService`/`stakeholder-rules.ts` из T-0452: `shareAt`,
  `monthKey`, `parseMonth`.

## Шаги по порядку

1. **Курсы без записи** (`packages/fx/src/refresh.ts`): вынести тело
   `takeSnapshot` до `saveSnapshot` в экспортируемую
   `buildSnapshot(store, now): Promise<Omit<RatesSnapshot, "id">>`;
   `takeSnapshot` = `store.saveSnapshot(await buildSnapshot(store, now))`.
   Поведение `takeSnapshot` не меняется. В `FxService` — метод
   `peek(now = new Date())`, который зовёт `buildSnapshot` и ничего не пишет.
2. **Настройка** в `setting-catalog.ts`:

   ```ts
   paymentsHoldDaysTelegram: integer(
     "payments.hold-days.telegram",
     PAYMENTS_GROUP,
     "Холд оплаты звёздами, дней",
     "Через сколько дней звёзды оплаты становятся доступны к выводу. Кабинет участника считает по нему, сколько выручки ещё в холде",
     { min: 0, max: 90, unit: ["день", "дня", "дней"] },
     21,
   ),
   ```

   Строка в `docs/30-configuration-map.md`.
3. **Чистые расчёты** `modules/stakeholders/project-month.ts` (без Nest и
   Prisma):
   - вход — строки покупок месяца `{ chargedStars, paidAt, refundedAt, product, platform }`,
     `holdDays`, `now`, курсы `{ starUsd: Decimal; usdRub: Decimal } | null`,
     доля смотрящего в б. п. или `null`;
   - выход — `ProjectMonth`:

     ```ts
     interface ProjectMonth {
       revenue: {
         stars: { paid: number; refunded: number; net: number };
         byPlatform: { platform: "telegram" | "max" | "vk" | "web"; net: number }[]; // без нулевых, по убыванию
         bySource: { source: "shop" | "continue" | "vip" | "donation"; net: number }[];
         usd: string | null; // "123.45" — net × starUsd, вниз до цента
         rub: string | null; // usd × usdRub, вниз до копейки
       };
       hold: { days: number; inHoldStars: number; releasedStars: number; nextReleaseAt: string | null };
       draft: { sharePercent: number; usd: string | null; rub: string | null; stars: number } | null;
     }
     ```

     Холд считается только по невозвращённым оплатам; `nextReleaseAt` —
     самая ранняя `paidAt + days` из тех, что ещё в холде. Черновик в звёздах —
     `floor(net × bp / 10000)`. Деньги — `Decimal` из `@bh/fx`, без `number`
     в промежуточных суммах.
4. **Репозиторий** `project-month.repository.ts`: одна выборка
   `purchase JOIN account` по `mode = 'live' AND paid_at >= $start AND paid_at < $end`,
   только нужные поля, разбор Zod; и `firstPaidMonth()` — месяц самой ранней
   живой оплаты (для списка месяцев).
5. **Сервис** `project-month.service.ts`, `month(actor, monthKey?, now)`:
   - право `revenue.split.own.view` или `revenue.split.view`, иначе
     `ForbiddenError`;
   - месяц по умолчанию — текущий; раньше первого месяца оплат или в
     будущем — 400 `project_month_out_of_range`;
   - доля смотрящего: участник — `shareAt(история, месяц)`; владелец (право
     `stakeholders.manage`) — `10000 − сумма долей участников на месяц`;
     иначе — `null`;
   - курсы — `FxService.peek(now)`: `payout.get("XTR")` и `rates.get("RUB")`;
     нет любого — `null`;
   - ответ:

     ```ts
     interface MyProjectView {
       month: string;
       months: string[];                 // от первого месяца оплат до текущего, новые сверху
       viewer: { role: "stakeholder" | "owner" | "finance"; sharePercent: number | null; shareFrom: string | null };
       participants: { name: string; sharePercent: number; me: boolean }[]; // доли на этот месяц, без нулевых
       ownerSharePercent: number;
       rates: { starUsd: string; usdRub: string; at: string } | null;
       project: ProjectMonth;            // из шага 3
     }
     ```

6. **Контроллер** `admin/admin-my-project.controller.ts`:
   `@Controller("admin/my-project")`, охранник сессии, `GET /` с запросом
   `{ month?: "YYYY-MM" }` (Zod, `.strict()`) → `{ data: MyProjectView }`.
   Подключить в `admin.module.ts`; `route-permissions.test.ts`.
7. **Документы**: `docs/29-admin-panel.md` §6.6 — уже описывает кабинет
   (Р218); сверить формулировки с тем, что получилось, и поправить, если
   разошлись.

## Чего не трогаем

- Таблицы долей и права — T-0452.
- Экран — T-0455.
- `takeSnapshot` для цен и платежей — поведение то же, снимок пишется, как
  раньше.
- Ядро учёта, расходы, налог, займы — следующие волны (`docs/37`).

## Сценарий и интерфейс

- Участник с долей 25 % открывает ноябрь: оплачено 10 000 ⭐, возвращено
  300 ⭐ → чистая 9 700 ⭐; при курсе выплаты 0,013 $ — 126,10 $; черновик
  части — 31,52 $ (вниз), 2 425 ⭐.
- Курса выплаты звезды нет — `rates: null`, суммы в $ и ₽ — `null`, звёзды
  есть.

## Тесты

Первым коммитом:

- `backend/api/test/project-month.test.ts` (чистые расчёты):
  - пусто — нули, холд пуст, `nextReleaseAt: null`;
  - оплата и её возврат — в `refunded`, в `net` нет, в холде нет;
  - оплата 20 дней назад при холде 21 — в холде, `nextReleaseAt` = через
    день; 22 дня назад — вышла;
  - разбивка по площадкам и источникам, донат — «Донаты»;
  - округление вниз: 9 700 ⭐ × 0,013 = 126,10 $; доля 33,33 % → 42,02 $
    (126,10 × 0,3333 = 42,029…, вниз); рубли — вниз до копейки;
  - курсов нет — суммы `null`, звёзды есть; доли нет — `draft: null`.
- `packages/fx/test/refresh.test.ts`: `buildSnapshot` не вызывает
  `saveSnapshot`; `takeSnapshot` вызывает ровно один раз и отдаёт то же,
  что `buildSnapshot` с `id`.
- `backend/api/test/project-month.integration.test.ts` (Postgres): оплата
  31 октября 23:59:59 UTC — в октябре, 1 ноября 00:00 — в ноябре; тестовая
  оплата не входит; площадка — из аккаунта.
- `backend/api/test/admin-my-project.http.test.ts`: без сессии — 401; без
  прав — 403; участник видит свою долю и `me: true` у себя; владелец —
  остаток; финансы — `sharePercent: null`; месяц `2026-13` — 400; будущий
  месяц — 400.

## Аналитика

Нет событий: это чтение панели. Выручка берётся из `purchase` — тех же
данных, что «Сводка» и «Чего достигли».

## Настройки и окружение

- Новый ключ `payments.hold-days.telegram` (шаг 2) — строка в
  `docs/30-configuration-map.md`.

## Документы

- `docs/30-configuration-map.md` — ключ холда.
- `docs/29-admin-panel.md` §6.6 — сверка (шаг 7).

## Критерии приёмки

- [ ] Выручка месяца считается только по живым оплатам месяца по UTC, без
      возвращённых, по площадкам и источникам.
- [ ] Холд считается по настройке; ближайший выход холда верен.
- [ ] $ и ₽ — по курсу выплаты звезды и курсу рубля, вниз до цента и
      копейки; без курсов — только звёзды.
- [ ] Просмотр кабинета не пишет снимков курсов в базу.
- [ ] Участник, владелец и финансы видят каждый свою долю по Р218.
- [ ] Тесты из раздела «Тесты» есть и зелёные; гейт и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(finance): Месяц проекта для кабинета участника`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МЕСЯЦ ПРОЕКТА ДЛЯ КАБИНЕТА УЧАСТНИКА**

  Сервер отдаёт кабинету участника месяц проекта (Р218): выручку живыми
  оплатами без возвращённых — по площадкам и источникам, в ⭐, $ и ₽, холд и
  черновик своей части до расходов и налога.

  🛠 **Что внутри**

  • холд — настройка «Холд оплаты звёздами, дней» (21) в группе «Платежи»
  • $ — по курсу выплаты звезды, ₽ — по курсу рубля; округление вниз
  • просмотр не пишет снимков курсов: в ядре курсов появился buildSnapshot
  ```
