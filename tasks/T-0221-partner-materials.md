---
id: T-0221
title: Материалы для партнёров — баннеры, тексты постов и правила в кабинете
epic: E14
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0219]
zones:
  - backend/api/src/modules/partners/partner-materials.ts
  - backend/api/src/modules/partners/partner-materials.repository.ts
  - backend/api/src/modules/partners/partner-cabinet.ts
  - backend/api/src/modules/admin/admin-cabinet.controller.ts
  - backend/api/src/modules/admin/admin-partner-materials.controller.ts
  - backend/api/src/modules/media/image-rules.ts
  - backend/api/test/partner-materials.test.ts
  - backend/api/test/partner-materials.integration.test.ts
  - apps/admin/src/api/cabinet.ts
  - apps/admin/src/api/partner-materials.ts
  - apps/admin/src/screens/cabinet/**
  - apps/admin/src/screens/partners/PartnerMaterials.tsx
  - apps/admin/src/screens/partners/PartnersScreen.tsx
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/src/modules/admin/admin.module.ts
  - docs/21-diagrams.md
  - docs/23-referral-and-partner-program.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 4
---

# T-0221. Материалы для партнёров — баннеры, тексты постов и правила в кабинете

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0221.json)](README.md#значки-статуса) [![T-0219](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0219.json&label=T-0219)](T-0219-partner-cabinet-funnel.md)

## Зачем

Партнёру нужно, чем рассказать об игре: готовый баннер, текст поста,
правила программы. Сейчас это пересылают в личке, и у каждого своя версия.
После задачи команда выкладывает материалы в панели, а партнёр забирает их
во вкладке «Материалы» своего кабинета — все сразу одной версией.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р136: в
кабинете — материалы, которые выкладывает команда.

Решения `claude-lead-1` от 24.10.2026:

- **Материал** — таблица `partner_material`: `material_id`, `kind`
  (`banner` — картинка, `post` — текст поста, `rules` — правила),
  `title` (до 80), `text` (до 2000, у `post` и `rules` обязателен, у
  `banner` — подпись, может быть пустой), `image_id` (у `banner`
  обязателен), `partner_id` (пусто — для всех партнёров, задан — только
  ему), `sort`, `created_by`, `created_at`, `archived_at`.
- **Картинки** — тем же модулем `media`, новый профиль `partner_material`:
  не квадрат, стороны от 200 до 2048 px, право `partners.edit`.
- **Команда** — вкладка «Материалы» в разделе «Партнёры»: список, «Новый
  материал», правка, порядок, «В архив» (архивный партнёр не видит, но
  запись остаётся). Право — `partners.edit`.
- **Партнёр** — вкладка «Материалы» кабинета: общие и свои, без архивных,
  по `sort`; у текста — «Скопировать», у баннера — «Скачать» оригинал.
  Подставлять ссылку партнёра в текст поста — не в этой задаче: партнёр
  копирует свою ссылку со вкладки «Ссылки».
- **Партнёр — только через `PartnerCabinet.partnerOf`**: чужие материалы
  (`partner_id` другого) не уходят никогда, в том числе в режиме «глазами
  партнёра».

## Как сейчас

- `backend/api/src/modules/media/image-rules.ts:36–43` — `IMAGE_PROFILES`
  (`task`, `home_slide`) с правом на загрузку; `MediaService.upload`.
- После T-0218 и T-0219: кабинет со вкладками «Ссылки», «Промокоды»,
  «Воронка»; `PartnerCabinet.partnerOf`.
- `apps/admin/src/screens/partners/PartnersScreen.tsx` — раздел «Партнёры».

## Шаги по порядку

1. **Миграция** `partner_material` и модель Prisma блоком в конце файла;
   строка в `wipe-plan.ts` (`keep`: материалы не игроков) и счётчик в
   тесте.
2. **Профиль картинки** `partner_material` в `IMAGE_PROFILES`.
3. **Сервер** — `partner-materials.ts` (правила и сервис),
   репозиторий, контроллер команды
   (`GET/POST /admin/partner-materials`, `POST /admin/partner-materials/:id`,
   `PUT /admin/partner-materials/:id/archive`) и `GET /admin/cabinet/materials`
   в кабинете.
4. **Панель** — `PartnerMaterials.tsx` во вкладке раздела «Партнёры» и
   вкладка «Материалы» кабинета.
5. **Документы:** `docs/21` — `partner_material` в ER; `docs/23` §4.4 —
   строка о материалах.

## Чего не трогаем

- Подстановку ссылки партнёра в текст — отдельной задачей, если понадобится.
- Модуль `media`, кроме нового профиля.

## Сценарий и интерфейс

Команда: «Партнёры» → «Материалы» → «Новый материал» → вид «Баннер»,
название, картинка, для всех или одному партнёру. Партнёр: «Кабинет» →
«Материалы» — карточки «Баннер для поста 1080×1080 — Скачать», «Текст для
анонса — Скопировать». Состояния: загрузка, пусто («Команда ещё не
выложила материалы»), ошибка с повтором.

## Тесты

Первым коммитом.

- `partner-materials.test.ts` — схема: `banner` без картинки → ошибка;
  `post` без текста → ошибка; текст 2001 символ → ошибка.
- `partner-materials.integration.test.ts`:
  - партнёр видит общие и свои, не видит чужие и архивные;
  - режим «глазами партнёра» не отдаёт материалы другого партнёра;
  - загрузка картинки профиля `partner_material` без `partners.edit` →
    отказ.
- `wipe-plan.test.ts` — счётчик моделей.
- Снимки вкладки команды и вкладки кабинета — в PR.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] Команда выкладывает баннеры, тексты постов и правила, общие и для
  одного партнёра.
- [ ] Партнёр видит в кабинете только общие и свои, без архивных.
- [ ] ER-диаграмма обновлена.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(partners): Материалы для партнёров в кабинете`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МАТЕРИАЛЫ ДЛЯ ПАРТНЁРОВ**

  В разделе «Партнёры» появилась вкладка «Материалы»: баннеры, тексты постов и правила программы — для всех партнёров или одному. Партнёр забирает их во вкладке «Материалы» своего кабинета: текст копирует, баннер скачивает.
  ```
