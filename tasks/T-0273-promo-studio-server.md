---
id: T-0273
title: Промо — сервер: пресеты команды, картинки для макетов, выдача пресетов партнёрам и журнал выгрузок
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0272, T-0221]
zones:
  - backend/api/src/modules/promo-studio/**
  - backend/api/src/modules/admin/admin-promo-studio.controller.ts
  - backend/api/test/promo-studio.test.ts
  - backend/api/test/promo-studio.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/package.json
  - backend/api/src/app.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/admin/admin-cabinet.controller.ts
  - backend/api/src/modules/admin/admin-limits.ts
  - backend/api/src/modules/media/image-rules.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - pnpm-lock.yaml
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 5
---

# T-0273. Промо — сервер: пресеты команды, картинки для макетов, выдача пресетов партнёрам и журнал выгрузок

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0273.json)](README.md#значки-статуса) [![T-0272](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0272.json&label=T-0272)](archive/T-0272-promo-kit-model.md) [![T-0221](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0221.json&label=T-0221)](T-0221-partner-materials.md)

## Зачем

Генератору промо (Р159) нужно, где хранить пресеты — макеты команды, из
которых делают материалы. И нужно, кому их отдавать: маркетологу всё, а
партнёру — только открытые партнёрам и опубликованные. После задачи на
сервере:
- пресеты с проверкой документа пакетом `promo-kit`;
- картинки для макетов (фоны, арт) — своим профилем;
- выдача пресетов в кабинет партнёра;
- журнал выгрузок: кто, какой пресет, с каким кодом и ссылкой.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р159.

Решения `claude-lead-1` от 25.10.2026:

- **Таблица** `promo_template`:
  - `template_id` uuid;
  - `title` — до 80;
  - `doc` jsonb — документ `promoDocSchema` из `@bh/promo-kit`, проверяется
    при каждой записи;
  - `thumb_image_id` — превью из `media`, может быть пусто;
  - `audience` — `team` или `partners`: партнёрам видны только `partners`;
  - `status` — `draft` или `published`;
  - `sort`, `created_by`, `updated_by`, `created_at`, `updated_at`,
    `archived_at`.

  Удаления нет — «В архив».
- **Права:**
  - новое право `promo.studio.edit` — пресеты и выгрузки команды; у ролей
    `owner`, `admin`, `marketer`;
  - партнёр — через `partner.cabinet` и `PartnerCabinet.partnerOf` (T-0217):
    видит только `published` с `audience: partners`, без архивных;
  - в режиме «глазами партнёра» — только чтение.
- **Маршруты команды** — `admin-promo-studio.controller.ts`:
  - `GET /api/v1/admin/promo-templates` — список, фильтр `status`, `audience`, архив;
  - `GET /api/v1/admin/promo-templates/:id`;
  - `POST /api/v1/admin/promo-templates` — новый;
  - `POST /api/v1/admin/promo-templates/:id` — правка с `updatedAt` из
    чтения: чужая правка между чтением и записью → 409 `promo_template_stale`;
  - `PUT /api/v1/admin/promo-templates/:id/archive`.
- **Маршрут кабинета** — `GET /api/v1/admin/cabinet/promo-templates` в
  `admin-cabinet.controller.ts`, по образцу материалов T-0221.
- **Картинки макетов** — профиль `promo_asset` в `IMAGE_PROFILES`:
  - не квадрат, стороны 200…2048;
  - право `promo.studio.edit`.

  Фон сторис 1080×1920 в WebP в 200 КБ не влезает. Поэтому у профиля
  появляется своё необязательное поле `maxBytes`: у `promo_asset` — 600 КБ,
  у остальных — по-прежнему `IMAGE_MAX_BYTES`. Проверка `checkImage` берёт
  предел профиля.

  Фото партнёра на сервер не уходит вовсе (слой `{ local: true }`, T-0272) —
  партнёру права загрузки не даём.
- **Документ ссылается на картинки** — каждый `{ media: <id> }` в `doc` и
  `thumb_image_id` проверяются `MediaService.require(id, "promo_asset")`.
  Ссылки на несуществующую картинку → 422 с id слоя.
- **Журнал выгрузок** — `POST /api/v1/admin/promo-studio/exports`:
  - тело `{ templateId, format, campaignId?, linkCode? }`;
  - запись — в журнал аудита (`AuditEntry`, действие `promo.export`, цель —
    `templateId`, в `after` — формат, кампания, ссылка, партнёр);
  - у партнёра — только его кампании и ссылки: чужой `campaignId` → 403;
  - лимит — новый `ADMIN_LIMITS.promoExport`: 60 за 10 минут.

  Картинку сервер не получает и не хранит — её собирает браузер.
- **Пределы:** `doc` до 256 КБ JSON, пресетов в работе (не в архиве) — до
  200.

## Как сейчас

- **Медиа** — `media/image-rules.ts`:
  - `IMAGE_PROFILES`, общий `IMAGE_MAX_BYTES`;
  - `checkImage`;
  - `MediaService.require`.
- **Права** — `roles/permissions.ts`, список прав и наборы ролей (`marketer`).
- **Кабинет** — после T-0217–T-0221:
  - `admin-cabinet.controller.ts`, `PartnerCabinet.partnerOf`;
  - материалы `partner_material` — образец маршрута кабинета и архива.
- **Аудит** — модель `AuditEntry`; запись — как у других действий панели
  (`roles/roles.service.ts`).
- **Пакет** — после T-0272 `@bh/promo-kit`: `promoDocSchema`, `FORMATS`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция:**
   - `promo_template` и модель Prisma;
   - строка в `wipe-plan.ts` (`keep`: пресеты — не данные игроков) и счётчик в тесте;
   - ER в `docs/21`.
3. **Зависимость** `@bh/promo-kit` в `backend/api/package.json`
   (`workspace:*`).
4. **Медиа** — профиль `promo_asset` и `maxBytes` у профиля.
5. **Модуль `promo-studio`:**
   - `promo-templates.repository.ts`;
   - `promo-templates.service.ts` — проверки по «Решениям»;
   - `promo-exports.service.ts`.
6. **Маршруты** команды и кабинета, лимит.
7. **Право** `promo.studio.edit` и наборы ролей.
8. **`docs/29`** — раздел «Промо»: что есть у команды и у партнёра.

## Чего не трогаем

- Редактор и экраны — T-0274–T-0277.
- Материалы T-0221 — пресеты живут рядом, не вместо.

## Тесты

Первым коммитом.

- `promo-studio.test.ts` — правила:
  - документ не по схеме → отказ с путём;
  - 201-й пресет в работе → отказ;
  - партнёр видит только `published` и `partners`.
- `promo-studio.integration.test.ts`:
  - создание и правка пресета маркетологом;
  - без `promo.studio.edit` → 403;
  - правка со старым `updatedAt` → 409;
  - картинка `{ media }` не существует → 422;
  - картинка профиля `task` в фоне → 422 (не тот профиль);
  - `promo_asset` 500 КБ — принят, 700 КБ — отказ; `task` 300 КБ — по-прежнему
    отказ;
  - кабинет: `draft` и `team` не уходят; «глазами партнёра» — только чтение;
  - выгрузка: строка аудита `promo.export`; чужой `campaignId` у партнёра → 403;
  - 61-я выгрузка за 10 минут → 429.
- `wipe-plan.test.ts` — счётчик моделей.

## Аналитика

Выгрузка — строкой аудита: это действие человека в панели, игрока оно не
касается. Что материал принёс — видно по коду и ссылке, их активации и
переходы уже считаются.

## Настройки и окружение

Нет.

## Документы

`docs/21`, `docs/29` — по шагам 2 и 8.

## Критерии приёмки

- [ ] Пресеты команды хранятся с проверкой документа пакетом `promo-kit`, правка — без затирания чужой.
- [ ] Партнёр получает только опубликованные пресеты для партнёров.
- [ ] Картинки макетов — профилем `promo_asset` до 600 КБ; прочие профили не изменились.
- [ ] Выгрузка пишется в аудит; партнёр не выгружает с чужим кодом.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Промо — пресеты и журнал выгрузок`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОМО, СЕРВЕР**

  Сервер генератора промо: пресеты команды с проверкой макета, картинки для макетов до 600 КБ, выдача опубликованных пресетов партнёрам в кабинет и журнал выгрузок в аудите. Право — promo.studio.edit (владелец, админ, маркетолог).
  ```
