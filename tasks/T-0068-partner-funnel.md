---
id: T-0068
title: Воронка партнёра — по его ссылкам, кодам и площадкам
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0067, T-0053]
zones:
  - backend/api/src/modules/funnel/funnel-report.ts
  - backend/api/src/modules/funnel/funnel.repository.ts
  - backend/api/src/modules/partners/partners.service.ts
  - backend/api/src/modules/admin/admin-partners.controller.ts
  - backend/api/test/funnel.integration.test.ts
  - backend/api/test/partners.test.ts
  - apps/admin/src/api/partners.ts
  - apps/admin/src/screens/partners/PartnerCard.tsx
  - apps/admin/src/screens/partners/partner-funnel.tsx
  - apps/admin/test/partners.test.ts
shared:
  - docs/23-referral-and-partner-program.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0068. Воронка партнёра — по его ссылкам, кодам и площадкам

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0068.json)](README.md#значки-статуса) [![T-0067](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0067.json&label=T-0067)](archive/T-0067-partner-links-and-binding.md) [![T-0053](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0053.json&label=T-0053)](archive/T-0053-funnel-chart-screen.md)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р96): по
партнёру нужно видеть воронку по всем его ссылкам и площадкам — как далеко
доходят игроки, которых он привёл. Сейчас воронка панели — только по
источникам первого касания, без партнёров.

## Решения

- **Чья воронка** — игроки, привязанные к партнёру (`partner_binding`): по
  коду или по ссылке (T-0067). Те, кто пришёл по ссылке партнёра, но
  привязан к другому (слот был занят), — не его.
- **Разбивка:**
  - строка «Все игроки партнёра»;
  - по источнику привязки — «ссылка <кампания> · <код>» или «код
    <название кампании промокода>»;
  - по площадке.
- **Период** — по дате привязки (`bound_at`): «7 · 30 · 90 · свой», как на
  экране воронки (T-0053).
- **Вехи** — те же девять (`FUNNEL_STEPS`). Полосы — тем же
  `FunnelChart` (T-0053).
- **Прямые ссылки в общей воронке.** Касание `link` (T-0057) в отчёте
  воронки относится к кампании своей ссылки, как `click`. Сейчас оно
  попало бы в «неизвестно».

## Как сейчас

- **`backend/api/src/modules/funnel/funnel-report.ts:61`** —
  `funnelReport(prisma, from, to)`:
  - одна выборка из `account_funnel` с `acquisition`, `link_click`, `link`;
  - группировка по площадке, виду касания, кампании, источнику;
  - вид `click` → кампания ссылки по клику.
- **`funnel.repository.ts`** — `report(from, to)`.
- **`partners.service.ts`** — `detail(actor, partnerId)`.
- **Привязки** — `partner_binding` (`campaign_id` — код, `link_code` —
  ссылка, T-0067).
- **Панель:**
  - `screens/partners/PartnerCard.tsx`;
  - `FunnelChart` и `funnelBars` — `screens/funnel/funnel-chart.tsx` и
    `api/funnel.ts` (T-0053);
  - `presetPeriod`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`funnel-report.ts`:**
   - вид `link` — к ссылке по `q.first_start_ref = l.code`;
   - кампания и источник — как у `click`.
3. **Новая выборка** `partnerFunnelReport(prisma, partnerId, from, to)`:
   - те же счётчики вех;
   - `FROM partner_binding pb JOIN account_funnel f …`;
   - окно — по `pb.bound_at`;
   - группировка — площадка и источник привязки:

     ```sql
     CASE WHEN pb.link_code IS NOT NULL THEN 'link' ELSE 'code' END AS via,
     COALESCE(l.campaign, pc.name) AS via_name,
     COALESCE(pb.link_code, pc.code) AS via_ref
     ```

     `pc` — кампания промокода (`campaign_id`); имя таблицы и полей сверить
     со схемой.
   - лимит строк — как у `funnelReport`.
4. **`funnel.repository.ts`** — `partnerReport(partnerId, from, to)`.
5. **`partners.service.ts`** — `funnel(actor, partnerId, from, to)`:
   - право `partners.view`;
   - партнёра нет — 404;
   - период не длиннее 366 суток.
6. **`admin-partners.controller.ts`** — `GET /api/v1/admin/partners/:id/funnel?from=&to=`.
7. **Панель** — новый `screens/partners/partner-funnel.tsx`, блок в
   `PartnerCard`:
   - чипы периода (`presetPeriod`, T-0053);
   - `FunnelChart` по строке «Все игроки партнёра»;
   - таблица источников привязки и площадок с вехами числом и долей;
   - пусто — «За период к партнёру никто не привязан».
8. **Документы** — раздел «Документы».

## Чего не трогаем

- Экран «Воронка» — кроме того, что прямые ссылки встают к своей кампании.
- Начисления партнёру.

## Тесты

Первым коммитом.

- **`backend/api/test/funnel.integration.test.ts`** (Postgres):
  - аккаунт с первым касанием `link` стоит в отчёте под кампанией своей
    ссылки;
  - воронка партнёра:
    - два игрока по ссылке и один по коду → три строки «все», две
      строки источников, верные вехи;
    - игрок другого партнёра в ней не виден;
    - окно — по дате привязки.
- **`backend/api/test/partners.test.ts`:**
  - `funnel` без `partners.view` — отказ;
  - партнёра нет — 404;
  - период 400 суток — 400.
- **`apps/admin/test/partners.test.ts`** — разбор ответа воронки.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- **`docs/23-referral-and-partner-program.md`** — воронка партнёра: чьи
  игроки, по дате привязки, разбивка по источнику и площадке.

## Критерии приёмки

- [ ] В карточке партнёра — воронка его игроков полосами и таблицей по
  ссылкам, кодам и площадкам за выбранный период.
- [ ] Прямые ссылки в общей воронке — под своей кампанией.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(admin): Воронка партнёра в его карточке`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВОРОНКА ПАРТНЁРА**

  В карточке партнёра видна воронка его игроков: сколько дошло до первого забега, до пятого, вернулось на следующий день и купило — по каждой его ссылке, коду и площадке за 7, 30 или 90 дней.
  ```
