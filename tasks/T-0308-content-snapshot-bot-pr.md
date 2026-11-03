---
id: T-0308
title: История баланса в git — публикация «Всем» открывает PR от бота в dev со снимком версии и списком правок
epic: E7
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0306]
zones:
  - backend/api/src/modules/content/content-git-export.ts
  - backend/api/src/modules/content/content-git-export.job.ts
  - backend/api/test/content-git-export.test.ts
  - packages/core-game/src/content/published/README.md
  - packages/core-game/test/published-snapshots.test.ts
shared:
  - backend/api/src/modules/content/content.module.ts
  - backend/api/src/modules/content/content-publish.service.ts
  - backend/api/src/modules/secrets/secret-catalog.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/infra/outbound/outbound-services.ts
  - docs/19-content-admin.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 7
---

# T-0308. История баланса в git — публикация «Всем» открывает PR от бота в dev со снимком версии и списком правок

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0308.json)](README.md#значки-статуса) [![T-0306](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0306.json&label=T-0306)](T-0306-content-publish.md)

## Зачем

После T-0306 баланс меняется в базе, а git о правках не знает. Если база
пропадёт, пропадёт и история баланса (`docs/19` §7). После задачи каждая
публикация «Всем» открывает PR от бота в `dev`:
- снимок версии файлом;
- список правок словами.

История читается через `git log`. Тимлид вливает PR как обычно, CI
проверяет снимок схемой.

## Решения

Решение владельца — 25.10.2026, опрос: история — **PR от бота в `dev`**.
Прямой записи в `dev` у сервера нет.

Решения `claude-lead-1` от 25.10.2026:

- **Что в PR:**
  - файл `packages/core-game/src/content/published/v{N}.json` — снимок
    версии как есть;
  - описание PR:
    - список правок против прошлой опубликованной («Волк · урон 7 → 9»);
    - кто и когда опубликовал;
    - отчёт проверки (медианы против коридоров).

  `content/*.ts` не трогаются: они — умолчание и эталон golden (Р16).
- **Оформление:**
  - заголовок — `chore(content): Снимок баланса v{N}`;
  - метка `release: none`: версия уже у игроков, PR — история;
  - ветка `content/v{N}`;
  - разделы описания по формату `pre-pr`, «Сводка для команды» — строкой о
    версии.
- **Токен** — ключ интеграции `github.content-bot` в каталоге ключей
  (`secrets/secret-catalog.ts`, Р84): токен GitHub с правами на содержимое
  и PR этого репозитория, без прав администратора. Репозиторий — ключ
  панели `content.git-repo` (`владелец/имя`).
  - Нет токена — экспорта нет, в лог раз в сутки «Экспорт снимков в git
    выключен: нет ключа».
  - Ключ задан — включено (Р53).
- **Отправка** — задание очереди после публикации:
  - не мешает публикации;
  - повтор при сбое — 5 раз с паузой;
  - идемпотентно: ветка `content/v{N}` уже есть — PR не открывается второй
    раз.
- **Сеть** — `Outbound.forService` с новой меткой `github.api`; таймаут
  10 с.
- **CI** — `published-snapshots.test.ts`: каждый файл `published/*.json`
  проходит `contentSnapshotSchema`, хэш файла совпадает с номером в
  описании (поле `hash` внутри).

## Как сейчас

- **После T-0306** — публикация и версии.
- **Каталог ключей интеграций** — `secrets/secret-catalog.ts`; каталог
  настроек — `settings/setting-catalog.ts`.
- **Исходящие** — `infra/outbound/outbound-services.ts`.

## Шаги по порядку

1. **Тесты первым коммитом:**
   - `content-git-export.test.ts` — с подставным GitHub:
     - ветка, файл, PR;
     - повтор — без второго PR;
     - нет ключа — ничего;
   - `published-snapshots.test.ts`.
2. **`content-git-export.ts`, `.job.ts`** — задание после публикации.
3. **Ключи** — `github.content-bot`, `content.git-repo`; метка `github.api`.
4. **`published/README.md`** — что лежит в каталоге и почему `content/*.ts`
   не меняются.
5. **Документы** — `docs/19` §7 (PR вместо прямого коммита); `docs/30`.

## Чего не трогаем

- Публикацию — T-0306.
- `content/*.ts`.

## Тесты

Первым коммитом — шаг 1.

## Аналитика

Нет.

## Настройки и окружение

Ключ интеграции `github.content-bot`, ключ панели `content.git-repo`.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] Публикация «Всем» открывает PR от бота в `dev` со снимком и списком правок, ровно один на версию.
- [ ] Нет ключа — экспорт выключен без ошибок; CI проверяет снимки схемой.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Снимок баланса в git через PR бота`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИСТОРИЯ БАЛАНСА В GIT**

  Каждая публикация баланса «Всем» открывает PR от бота в dev: снимок версии файлом и список правок словами. Нужен ключ интеграции github.content-bot в панели — без него экспорт выключен.
  ```
