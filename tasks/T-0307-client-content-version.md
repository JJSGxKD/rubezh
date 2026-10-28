---
id: T-0307
title: Клиент играет опубликованной версией контента — берёт её при входе, хранит по хэшу, забег держит свою версию до конца; сервер знает хэши из базы
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0306]
zones:
  - packages/app-shell/src/state/content-version.ts
  - packages/app-shell/test/content-version.test.ts
  - backend/api/test/content-known-hashes.integration.test.ts
shared:
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/meta.ts
  - packages/app-shell/src/app/App.tsx
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/core-game/src/index.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/content/content.module.ts
  - backend/api/src/config/app-config.ts
  - .env.example
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/19-content-admin.md
  - docs/20-env-and-ports.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 7
---

# T-0307. Клиент играет опубликованной версией контента — берёт её при входе, хранит по хэшу, забег держит свою версию до конца; сервер знает хэши из базы

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0307.json)](README.md#значки-статуса) [![T-0306](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0306.json&label=T-0306)](T-0306-content-publish.md)

## Зачем

Публикация (T-0306) ставит текущую версию контента, а клиент всё ещё
играет тем, что собрано в его сборке. После задачи:
- клиент при входе спрашивает текущую версию;
- скачивает снимок по хэшу (один раз — потом из кеша);
- передаёт его движку.

Забег идёт той версией, с которой начался, даже если посреди забега
опубликовали новую. Сервер принимает забег, если хэш его контента есть
среди версий в базе (Р16), а не только в окружении.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р16 — движок получает снимок параметром; список хэшей из окружения
  (`RUNS_KNOWN_CONTENT_HASHES`) уходит в базу;
- 25.10.2026 — шаг 2 редактора.

Решения `claude-lead-1` от 25.10.2026:

- **Когда спрашивать** — после входа, вместе с профилем: `GET /content/current?schema=<SCHEMA_VERSION>` (T-0306).
  - Ответ — `{ versionNo, hash, url }`.
  - Тот же хэш, что в сборке, — ничего не качать.
- **Кеш** — снимок по хэшу в Cache Storage браузера (`content:<hash>`).
  - Недоступно — в памяти до перезапуска.
  - Ошибки чтения и записи — `try/catch`, без падения.
- **Проверка** — снимок проверяется схемой `contentSnapshotSchema` (T-0301)
  и хэшем `hashSnapshot`.
  - Не прошёл — играть встроенным, отчёт в журнал ошибок клиента.
- **Нет сети, сервер не ответил за 3 с, снимок не скачался** — встроенный
  контент сборки. Играть можно всегда.
- **Забег** — `RunOptions.content` — снимок, взятый **на старте**.
  - Новая версия посреди забега его не трогает.
  - Снимок прерванного забега хранит хэш. Продолжение без снимка этого хэша
    в кеше качает его по адресу, а не удалось — забег продолжается
    встроенным с пометкой `content_mismatch` в итоге.
- **Гайдбук и карточки** — тексты и числа — из того же снимка: игрок видит
  то, с чем играет (`guide-data.ts`).
- **Сервер: известные хэши** — хэш контента забега принимается, если он:
  - есть в `content_version`;
  - или есть в `RUNS_KNOWN_CONTENT_HASHES` — переходный список для старых
    клиентов.

  Иначе — причина вердикта `unknown_content`, как сейчас. Переменная
  остаётся, но становится дополнением к базе, а не единственным источником.

## Как сейчас

- **Хэш контента в итоге** — `CONTENT_HASH`. Проверка — `run-verdict.ts`
  (`unknown_content`), список — `RUNS_KNOWN_CONTENT_HASHES`
  (`config/app-config.ts:168`).
- **После T-0301** — `RunOptions.content`, `contentSnapshotSchema`,
  `hashSnapshot`. **После T-0306** — `GET /content/current`, `GET /content/v/<hash>.json`.
- **Запуск забега** — `state/run.ts`; профиль после входа — `state/meta.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`state/content-version.ts`** — запрос, кеш, проверка, выбор снимка.
3. **Забег** — снимок на старте; продолжение по хэшу.
4. **Гайдбук** — данные из снимка.
5. **Сервер** — хэши из базы плюс окружение.
6. **Документы:**
   - `docs/19` §3 и §5;
   - `docs/20` — `RUNS_KNOWN_CONTENT_HASHES` теперь дополнение к базе;
   - `docs/27` — загрузка контента.

## Чего не трогаем

- Публикацию — T-0306.
- Перепроверку повтором — WP5.

## Тесты

Первым коммитом.

- `content-version.test.ts`:
  - тот же хэш — без скачивания;
  - новый — скачан, проверен, в кеше;
  - испорченный снимок — встроенный и отчёт;
  - нет сети — встроенный;
  - кеш бросает исключение — работа идёт;
  - публикация посреди забега — забег на старом снимке.
- `content-known-hashes.integration.test.ts`:
  - хэш из `content_version` — принят;
  - хэш из окружения — принят;
  - неизвестный — `unknown_content`.

## Аналитика

`run_started` получает `content_version` (номер) — сначала словарь `docs/22`
и Zod: правку баланса отделить от сезонности.

## Настройки и окружение

`RUNS_KNOWN_CONTENT_HASHES` меняет смысл на «дополнение» — `docs/20` §7,
строка в `.env.example`.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Клиент играет текущей опубликованной версией, качает её один раз по хэшу; без сети — встроенной.
- [ ] Забег держит версию старта; гайдбук показывает ту же версию.
- [ ] Сервер принимает хэши версий из базы.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Игра на опубликованной версии баланса`
- **Метка:** `release: minor`
- **Для игроков:** пусто — для игрока всё как было, просто баланс теперь обновляется без релиза.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БАЛАНС БЕЗ РЕЛИЗА**

  Клиент при входе берёт опубликованную версию баланса и играет ею; забег держит версию, с которой начался; без сети — встроенная. Сервер узнаёт версии забегов из базы. С этого PR правка в «Балансе» доходит до игроков без релиза.
  ```
