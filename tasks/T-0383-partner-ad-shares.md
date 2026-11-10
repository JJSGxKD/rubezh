---
id: T-0383
title: Реклама игроков партнёра — доли по сетям, местам и блокам во вкладке карточки
epic: E14
priority: P2
status: ready
owner:
author: claude-lead2-3
size: M
depends_on: [T-0382]
zones:
  - backend/api/src/modules/partners/partner-ads.ts
  - backend/api/src/modules/partners/partner-ads.repository.ts
  - backend/api/src/modules/admin/admin-partner-ads.controller.ts
  - backend/api/test/partner-ads.test.ts
  - backend/api/test/partner-ads.integration.test.ts
  - apps/admin/src/api/partner-ads.ts
  - apps/admin/src/screens/partners/PartnerAdsTab.tsx
  - apps/admin/src/screens/partners/partner-card-rules.ts
  - apps/admin/src/screens/partners/PartnerCard.tsx
  - apps/admin/test/partner-ads.test.ts
  - apps/admin/test/partner-card.test.ts
shared:
  - backend/api/src/modules/partners/partners.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/ui/help.ts
  - docs/23-referral-and-partner-program.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0383. Реклама игроков партнёра — доли по сетям, местам и блокам во вкладке карточки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0383.json)](README.md#значки-статуса) [![T-0382](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0382.json&label=T-0382)](T-0382-partner-card-page.md)

## Зачем

Команда решает, давать ли партнёру бонус, а видит только, сколько игроков он
привёл и сколько они заплатили. Рекламу его игроков не видно. После задачи в
карточке партнёра есть вкладка «Реклама»: показы, досмотры и забранные награды
его игроков, их доля от всех и доля досмотра против средней — по сети, месту в
игре и блоку, за 7, 30 и 90 дней.

## Решения

Записаны в `docs/35-stage4-plan.md` Р190 (02.11.2026) и Р191. Исполнитель их не
пересматривает.

1. **Вкладка «Реклама» в карточке партнёра** (страница — T-0382).
2. **Что считаем**: показы, досмотры и забранные награды игроков партнёра;
   **их доля от всех** и **доля досмотра против средней** — по сети, месту в
   игре и блоку, **за 7, 30 и 90 дней**.
3. **Выполненное рекламное действие — досмотр** (`ad_session.completed_at`).
4. **Показ относится к партнёру, если случился после привязки** игрока к нему
   (`partner_binding.bound_at`).
5. **Только для команды**: партнёру не показывается (ни в кабинете, ни в его
   выдаче). Денег не считаем: сеть выручку по показу не отдаёт.

Решения `claude-lead2-3` по коду (способ, не продукт):

6. **Показ — сессия с блоком**: `block_id IS NOT NULL`. Сессия без блока — пропуск
   VIP, а не показ (`ad_session_pass_check`, `ads-catalog.repository.ts:248–254`).
   Счётчики — как в воронке раздела «Реклама» (`ads-catalog.repository.ts:229`,
   `funnel`): показы — `count(shown_at)`, досмотры — `count(completed_at)`,
   забрано — `count(claimed_at)`, окно — по `created_at`. Так цифры вкладки
   сходятся с разделом «Реклама».
7. **Время показа для привязки — выдача сессии** (`created_at >= bound_at`):
   сессию выдают по запросу показа, и от показа её отделяют секунды; по
   `created_at` же окно воронки и индексы.
8. **Право — `partners.view`**: вкладка — часть карточки партнёра, которая
   открывается под ним (`admin-partners.controller.ts:39`). Роль `partner`
   (T-0217) этого права не имеет, кабинет данные не получает.
9. **Индексов и миграций нет** — план в разделе «Как сейчас».

## Как сейчас

- `backend/api/prisma/schema.prisma:1892–1928` — `AdSession`: `account_id`,
  `place`, `block_id` (пусто — пропуск), `network_key`, `created_at`, `shown_at`,
  `completed_at`, `claimed_at`; индексы `(account_id, place, created_at)`,
  `(created_at)`, `(completed_at)`. `AdBlock` (`:1864`) — `network_key`, `place`,
  `external_id`. `PartnerBinding` (`:2186`) — `account_id` PK, `partner_id`,
  `bound_at`, индекс `(partner_id, bound_at)`.
- Образец связки рекламы с когортой — `modules/funnel/flag-split-report.ts:119–131`
  (CTE `ads` по `account_id IN (SELECT … FROM cohort)`, `block_id IS NOT NULL`).
- Воронка показов — `modules/ads/ads-catalog.repository.ts:229` (`funnel`),
  пропуски — `:254` (`passes`).
- **План без нового индекса:**
  - игроки партнёра — `partner_binding` по `(partner_id, bound_at)`;
  - их сессии — `ad_session` по `(account_id, place, created_at)` (`account_id`
    первым), с условием `created_at >= greatest(bound_at, начало окна)`;
  - все сессии окна для «доли от всех» — по `(created_at)`, тот же запрос, что
    `funnel` раздела «Реклама».
  В PR — `EXPLAIN (ANALYZE, BUFFERS)` обоих запросов на тестовых данных
  (≥ 100 тыс. сессий, партнёр с ≥ 1000 игроков). Seq Scan по `ad_session` —
  вопрос тимлиду, своей миграции не заводить.
- Админ партнёров — `admin/admin-partners.controller.ts` (под T-0217, не
  трогать: новая ручка — своим контроллером); `partners/partners.module.ts`.
- Панель после T-0382: `screens/partners/PartnerCard.tsx` — страница с
  вкладками, `partner-card-rules.ts` — `PARTNER_TABS`, `partnerTabs`,
  `partnerTabOf`. Подписи мест — `apps/admin/src/api/ads.ts:28` `PLACE_TITLES`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`partners/partner-ads.ts`** (чистые правила, без Nest и Prisma):

   ```ts
   export const AD_WINDOWS = [7, 30, 90] as const;
   export const AD_CUTS = ["network", "place", "block"] as const;
   /** `days` — строка запроса, одно из `AD_WINDOWS`, по умолчанию 30; `by` — одно из `AD_CUTS`, по умолчанию `network`; лишние поля — ошибка. */
   export const partnerAdsQuerySchema: z.ZodType<{ days: AdWindow; by: AdCut }>;
   export interface AdCounts { shows: number; completes: number; claims: number }
   export interface PartnerAdsRow { key: string; network: string; place: string | null; blockId: string | null;
                                    externalId: string | null; partner: AdCounts; all: AdCounts }
   export interface PartnerAdsView { days: number; by: AdCut; from: string; to: string; rows: PartnerAdsRow[]; total: { partner: AdCounts; all: AdCounts } }
   ```

   Ключ строки: `network` — `network_key`; `place` — `network_key:place`; `block` —
   `block_id`. Строки — по убыванию `partner.shows`, затем `all.shows`.
3. **`partners/partner-ads.repository.ts`** — два запроса `$queryRaw` с разбором
   Zod (числа — `bigint` → `number`):
   - **партнёр:** `partner_binding b JOIN ad_session s ON s.account_id = b.account_id
     AND s.created_at >= b.bound_at` (решение 7), `b.partner_id = $1`,
     `s.block_id IS NOT NULL`, `s.created_at >= $from AND s.created_at < $to`,
     `GROUP BY` по разрезу, `count(shown_at)`, `count(completed_at)`,
     `count(claimed_at)`;
   - **все:** то же без привязки, по окну — как `funnel`.
   `block` джойнит `ad_block` за `external_id`, `network_key` и `place`.
4. **Сервис** — функция или метод в `partner-ads.repository.ts` под провайдером
   `PartnerAdsReport`: оба запроса параллельно, `withTimeout` 10 с каждый;
   строки склеиваются по ключу (у партнёра нет строки — нули); `total` — сумма.
   Партнёра нет (своим запросом `SELECT 1 FROM partner WHERE partner_id = $1`) →
   `PartnerNotFoundError` из `partner-errors.ts`.
5. **`admin/admin-partner-ads.controller.ts`** — `@Controller("admin/partners")`,
   `@UseGuards(AdminSessionGuard, PermissionGuard)`,
   `@Get(":partnerId/ads")`, `@RequirePermission("partners.view")`; разбор
   `partnerAdsQuerySchema`, ошибка — «Окно — 7, 30 или 90 дней, разрез — сеть,
   место или блок»; id — `z.uuid()`, «Некорректный id партнёра».
6. **Модули**: `partners.module.ts` — провайдер `PartnerAdsReport` и его
   `exports`; `admin.module.ts` — контроллер. Тест модуля проверяет, что
   контроллер получает провайдер.
7. **Панель — `api/partner-ads.ts`**: схема ответа; `fetchPartnerAds(api, id,
   days, by)`; чистые функции:
   - `shareOfAll(part, all)` — доля в процентах с одним знаком, `all = 0` → `null`;
   - `completionRate(c)` — `completes / shows`, `shows = 0` → `null`;
   - `rateVsAverage(row)` — разница долей досмотра в процентных пунктах
     («+4,2 п.п.», «−1,0 п.п.», нет данных — `null`).
8. **`screens/partners/PartnerAdsTab.tsx`** — вкладка: переключатели «Окно» (7 /
   30 / 90 дней) и «Разрез» (Сети / Места / Блоки), строка-итог и таблица
   «Сеть (место, блок) · Показы · Доля показов · Досмотры · Доля досмотров ·
   Забрано · Досмотр у его игроков · Средний досмотр · Разница». Подписи мест —
   `PLACE_TITLES`, блок — `external_id` или «без id блока» и сеть с местом.
9. **`partner-card-rules.ts`** — вкладка `{ id: "ads", title: "Реклама" }` в
   конец `PARTNER_TABS`, видна всем с `partners.view`; **`PartnerCard.tsx`** —
   ветка вкладки.
10. **Пояснения** — `ui/help.ts`, `HELP.partners.ads` дословно: «Реклама игроков
    партнёра после их привязки к нему: показы, досмотры и забранные награды —
    и их доля от всех показов игры за то же окно. «Досмотр у его игроков» против
    «Среднего досмотра» показывает, лучше ли его аудитория смотрит рекламу.
    Пропуски VIP не считаются. Партнёр этого не видит.»
11. **Документы** — раздел «Документы».

## Чего не трогаем

- Кабинет партнёра и его ручки — данные только команде (решение 5).
- `admin-partners.controller.ts`, `partners.service.ts`, `partners.repository.ts`
  (зоны T-0217): ручка — своим контроллером, запросы — своим репозиторием.
- Воронку раздела «Реклама» и `ads-catalog.repository.ts`.
- Схему БД — индексов и миграций нет (решение 9).
- Деньги: выручки по показу нет, оценок не строим.

## Сценарий и интерфейс

Карточка партнёра → вкладка «Реклама» (`#/partners/<id>/ads`) → по умолчанию 30
дней, разрез «Сети».

- **Загрузка** — `Loading` под переключателями; переключение окна или разреза —
  новый запрос, таблица остаётся до ответа.
- **Ошибка** — `ErrorNotice` с «Повторить».
- **Пусто**: у партнёра нет привязанных игроков — «Партнёр ещё не привёл
  игроков — рекламы считать не по чему»; игроки есть, показов нет — «За N дней
  у игроков партнёра не было показов рекламы».
- **Нет данных для доли** (у всех ноль показов в разрезе) — «—».
- **Без `partners.view`** — карточки нет вовсе (раздел закрыт).

Снимки в PR: вкладка с данными и пустая — на 390 и 1440 px, таблица в
телефонной раскладке `DataTable` на 390, без боковой прокрутки.

## Тесты

Первым коммитом.

- `backend/api/test/partner-ads.test.ts`:
  - схема: `days=7|30|90` годится, `days=14` → 400 с текстом из шага 5; `by=block`
    годится, `by=device` → 400; без параметров — 30 и `network`;
  - склейка строк: у партнёра нет строки сети, у всех есть → партнёр нули;
    порядок по `partner.shows`, затем `all.shows`; `total` — сумма;
  - без `partners.view` → 403; несуществующий партнёр → 404.
- `backend/api/test/partner-ads.integration.test.ts` (живой Postgres):
  - игрок привязан в день 10; сессии дня 9 и дня 11 → у партнёра только день 11,
    у «всех» — обе;
  - сессия без блока (пропуск VIP) не считается ни у партнёра, ни у всех;
  - показ, досмотр и забор считаются по своим колонкам: сессия с `shown_at` без
    `completed_at` — показ без досмотра;
  - окно 7 дней не берёт сессию восьмидневной давности, 30 — берёт;
  - разрез `block`: два блока одной сети — две строки с `external_id`;
  - игрок другого партнёра в счёт не идёт; игрок без привязки — только у «всех».
- `apps/admin/test/partner-ads.test.ts`: `shareOfAll(3, 40)` → «7,5 %»,
  `shareOfAll(0, 0)` → `null`; `completionRate({ shows: 0, … })` → `null`;
  `rateVsAverage` → «+4,2 п.п.» и «−1,0 п.п.»; запрос —
  `GET /api/v1/admin/partners/<id>/ads?days=30&by=network`; `HELP.partners.ads`
  без обращения на «ты».
- `apps/admin/test/partner-card.test.ts` (дописать): `partnerTabOf("ads", false)`
  → `ads`; `partnerTabs(true)` — пять вкладок, «Реклама» последней.

## Аналитика

Нет: отчёт панели только читает `ad_session`, события рекламы уже пишутся
(`docs/22-analytics-and-metrics.md`). Меток Prometheus с `partner_id` не заводим.

## Настройки и окружение

Нет. Окна и разрезы — константы `AD_WINDOWS`, `AD_CUTS` в `partner-ads.ts`.

## Документы

- `docs/23-referral-and-partner-program.md`: в разделе о карточке партнёра —
  вкладка «Реклама»: что считается (досмотр — `completed_at`, после привязки,
  без пропусков VIP), окна, что партнёр её не видит (Р190).
- `docs/29-admin-panel.md`: строка «Партнёры» — вкладка «Реклама», ручка
  `GET /api/v1/admin/partners/:partnerId/ads?days=&by=`, право `partners.view`.

## Критерии приёмки

- [ ] Вкладка «Реклама» в карточке партнёра: показы, досмотры, забрано, доля от
  всех и досмотр против среднего по сетям, местам и блокам за 7, 30 и 90 дней.
- [ ] Считаются только сессии с блоком, выданные после привязки игрока; пропуски
  VIP не считаются.
- [ ] Данные только команде: право `partners.view`, в кабинете партнёра их нет.
- [ ] Миграций нет; `EXPLAIN` обоих запросов в PR без Seq Scan по `ad_session`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-листы
  безопасности и нагрузки (`docs/15-engineering-standards.md` §7, §8).

## PR

- **Заголовок:** `feat(admin): Реклама игроков партнёра — доли по сетям и местам`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕКЛАМА ИГРОКОВ ПАРТНЁРА**

  В карточке партнёра появилась вкладка «Реклама»: сколько показов, досмотров и забранных наград у его игроков, какая это доля от всех и досматривают ли они лучше среднего — по сетям, местам в игре и блокам, за 7, 30 и 90 дней.

  🛠 **Что внутри**

  • считаются показы после привязки игрока к партнёру, без пропусков VIP
  • досмотр — выполненное рекламное действие
  • только для команды: партнёр вкладку не видит
  • денег не считаем — сеть выручку по показу не отдаёт
  ```
