---
id: T-0058
title: Переходник ссылок открывает Telegram диплинком — с запасным t.me
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0056, T-0057]
zones:
  - backend/api/src/modules/links/link-page.ts
  - backend/api/src/modules/links/redirect.controller.ts
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/link-targets.ts
  - backend/api/test/link-page.test.ts
  - backend/api/test/link-targets.test.ts
  - backend/api/test/links.test.ts
shared:
  - docs/24-attribution-and-sharing.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0058. Переходник ссылок открывает Telegram диплинком — с запасным t.me

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0058.json)](README.md#значки-статуса) [![T-0056](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0056.json&label=T-0056)](T-0056-panel-login-qr-deeplink.md) [![T-0057](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0057.json&label=T-0057)](T-0057-link-target-and-direct-links.md)

## Зачем

После клика переходник `/r/<код>` отвечает 302 на `https://t.me/<бот>?…`. На
ПК и в части мобильных браузеров это ещё одна страница t.me с кнопкой
«Открыть в Telegram» — лишний шаг, на котором теряем игроков.

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р95, Р94):
переходник открывает Telegram диплинком `tg://resolve` сразу. Telegram не
установлен — через пару секунд уходит на прежний `https://t.me/…`.

## Решения

- **Цели `app` и `bot`** — вместо 302 страница-переходник:
  1. скрипт сразу переходит по диплинку (`launchDeep` или `chatDeep`, T-0056);
  2. через 2,5 с, если страница всё ещё видна и не теряла фокус, —
     `location.replace` на `https://t.me/…`. Открылось приложение — окно
     браузера теряет фокус, и запасной переход не нужен;
  3. на странице две кнопки — «Открыть в Telegram» (диплинк) и «Открыть в
     браузере» (`https://`): без скрипта и если автопереход не сработал.
- **Цель `landing`**, площадка без диплинков и превью для краулеров — как
  сейчас: 302 и страница с OG-тегами.
- **Политика источников** страницы — без `'unsafe-inline'`:
  - скрипт один и постоянный, его `sha256` — в `script-src`;
  - адреса он берёт из `<script type="application/json">` — это данные, не
    код, политика их не исполняет.

  У остальных ответов API политика прежняя — `default-src 'none'`.
- **`Cache-Control: no-store`** — как у 302: клик одноразовый.

## Как сейчас

- **`backend/api/src/modules/links/redirect.controller.ts`:**
  - `visit.kind === "redirect"` → 302 `location: visit.target`;
  - превью — `html(200, linkPage({ url, target: null }), "private, max-age=300")`.
- **`links/link-page.ts`** — `linkPage({ url, target })`: OG-теги, ссылка
  «Открыть игру», `escapeHtml`.
- **`links/links.service.ts`** — `visit` (после T-0057 адрес — из
  `clickTarget` в `link-targets.ts`).
- **`backend/api/src/common/security-headers.ts`** —
  `content-security-policy: default-src 'none'; frame-ancestors 'none'` на
  всех ответах.
- **Порт ссылок** (после T-0056) — `launchDeep`, `chatDeep`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`link-targets.ts`:**

   ```ts
   /** Диплинк той же цели: только `app` и `bot`; у лендинга и площадки без диплинков — `null`. */
   export function clickDeepTarget(target: LinkTarget, clickId: string, builders: { launchDeep(p: string): string | null; chatDeep(p: string): string | null }): string | null;
   ```

3. **`links.service.ts`** — `Visit` `redirect` += `deep: string | null` из
   `clickDeepTarget` через `appLinks.launchDeep` и `appLinks.chatDeep`.
4. **`link-page.ts`:**
   - постоянный скрипт `OPEN_SCRIPT`, его хэш:

     ```ts
     export const OPEN_SCRIPT: string;
     /** `'sha256-…'` для `script-src`: считается от OPEN_SCRIPT при загрузке модуля. */
     export const OPEN_SCRIPT_HASH: string;
     export function openPage(options: { deep: string; fallback: string }): string;
     ```

   - скрипт читает `{ deep, fallback }` из
     `<script id="target" type="application/json">`;
   - сразу `location.href = deep`;
   - слушает `blur` и `visibilitychange`;
   - через 2500 мс — `location.replace(fallback)`, если страница видна и
     фокус не терялся;
   - JSON в разметке экранируется от `</script>`: `<` → `<`;
   - кнопки и заголовок — как в `linkPage`, тексты:
     - заголовок «Открываем Telegram…»;
     - «Открыть в Telegram» — диплинк;
     - «Открыть в браузере» — запасной;
     - строка «Не открылось? Нажмите кнопку».
5. **`redirect.controller.ts`:**
   - `redirect` с `deep !== null` → 200 `openPage(…)`;
   - заголовки:
     - `content-security-policy: default-src 'none'; script-src ${OPEN_SCRIPT_HASH}; frame-ancestors 'none'`;
     - `cache-control: no-store`;
     - `x-robots-tag: noindex`;
   - `deep === null` → 302, как сейчас.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Запись клика и параметры сети — до ответа, как сейчас.
- Превью и страницы «не найдено» и «недоступно».
- Политику источников остальных ответов API.

## Тесты

Первым коммитом.

- **`backend/api/test/link-targets.test.ts`** — `clickDeepTarget`:
  - `app` → `launchDeep("c-<клик>")`;
  - `bot` → `chatDeep("c-<клик>")`;
  - `landing` → `null`;
  - построитель вернул `null` → `null`.
- **`backend/api/test/link-page.test.ts`:**
  - `OPEN_SCRIPT_HASH` — `'sha256-<base64>'` от `OPEN_SCRIPT` (пересчитать в
    тесте `crypto.createHash`);
  - `openPage` — JSON с обоими адресами, `</script>` в адресе не закрывает
    тег;
  - обе кнопки с экранированными адресами;
  - в разметке нет другого `<script>` без `type="application/json"`, кроме
    `OPEN_SCRIPT`.
- **`backend/api/test/links.test.ts`:**
  - клик по ссылке `app` в Telegram → 200, страница, в CSP — хэш скрипта,
    `cache-control: no-store`;
  - ссылка `landing` → 302;
  - краулер → превью, как раньше.

## Аналитика

Нет: клик пишется, как раньше.

## Настройки и окружение

Нет.

## Документы

- **`docs/24-attribution-and-sharing.md`**, раздел о переходнике:
  - диплинк сразу;
  - запасной `https://t.me` через 2,5 с;
  - кнопки;
  - почему хэш скрипта, а не `'unsafe-inline'`.

## Критерии приёмки

- [ ] Клик по ссылке в Mini App или бота открывает Telegram диплинком, без
  страницы t.me.
- [ ] Без Telegram на устройстве через 2,5 с открывается `https://t.me/…`.
- [ ] Кнопки работают и без скрипта.
- [ ] Лендинг, превью и прочие ответы — как раньше.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Переходник ссылок открывает Telegram диплинком`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ССЫЛКИ ОТКРЫВАЮТ TELEGRAM СРАЗУ**

  Ссылки кампаний открывают Telegram сразу, без промежуточной страницы t.me: на ПК и в мобильных браузерах на один шаг меньше. Если Telegram не установлен, через пару секунд открывается обычная страница t.me.
  ```
