---
id: T-0057
title: Цель ссылки и прямые ссылки — Mini App, бот или лендинг, с переходником и без
epic: E14
priority: P1
status: done
owner: claude-6 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/attribution/start-param.ts
  - backend/api/src/modules/broadcasts/segment.ts
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/src/modules/links/link-targets.ts
  - backend/api/src/modules/admin/admin-links.controller.ts
  - backend/api/test/start-param.test.ts
  - backend/api/test/links.test.ts
  - backend/api/test/links.integration.test.ts
  - backend/api/test/link-targets.test.ts
  - apps/admin/src/api/links.ts
  - apps/admin/src/screens/links/LinksScreen.tsx
  - apps/admin/src/screens/links/LinkCard.tsx
  - apps/admin/test/links.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/24-attribution-and-sharing.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 1
---

# T-0057. Цель ссылки и прямые ссылки — Mini App, бот или лендинг, с переходником и без

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0057.json)](README.md#значки-статуса)

## Зачем

Сейчас ссылка кампании умеет одно:

- переходник `/r/<код>` считает клик;
- затем 302 в Mini App площадки (`t.me/<бот>?startapp=c-<клик>`).

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р95):

- **у ссылки — цель**: Mini App, бот или лендинг. Площадка — по-прежнему
  поле `platform`: другая площадка, когда игра там появится, — это её Mini
  App или бот;
- **прямая ссылка** — сразу в бота или Mini App, без переходника:
  - короче и без лишней страницы — в посте, в описании канала, у партнёра;
  - клика нет — считаются только запуски.

## Решения

- **Цель** — поле `target`:

  | `target` | Через переходник | Прямая ссылка |
  |---|---|---|
  | `app` (умолчание — как сейчас) | `launch(platform, c-<клик>)` — Mini App | `launch(platform, l-<код>)` |
  | `bot` | `chat(platform, c-<клик>)` — чат с ботом, `/start c-<клик>` | `chat(platform, l-<код>)` |
  | `landing` | `https://<домен>/?c=<клик>` | `https://<домен>/?l=<код>` |

  `<домен>` — тот же, на котором живёт переходник `/r/<код>` (лендинг —
  `docs/20-env-and-ports.md` §2.1).
- **Прямой ссылки нет у ссылки с сетью** (`network` задан, WP43): сети нужны
  макросы на клике (`{click_id}` и другие), а их пишет только переходник. В
  карточке такой ссылки вместо прямой — строка «Ссылка закупки — только
  через переходник: сети нужны параметры клика».
- **Параметр прямой ссылки** — `l-<код ссылки>`, новый вид касания `link`,
  `ref` — код ссылки. Касание по прямой ссылке — то же первое и последнее
  касание, что у клика (`docs/24-attribution-and-sharing.md`).
- **Запуски ссылки** — запуски по её кликам (как сейчас) плюс запуски по её
  прямой ссылке. В карточке и списке — раздельно: «через переходник» и
  «прямых».
- **Цель меняется после создания**: прошлые клики остаются, новые идут
  по-новому. Сеть и код — по-прежнему нет.

## Как сейчас

- **`backend/api/prisma/schema.prisma`:**
  - `model Link` — `code`, `platform` («куда ведёт»), `campaign`, `source`,
    `medium`, `note`, `network`, `registrationOn`;
  - `enum StartKind` — `organic, click, invite, telegram_affiliate, unknown,
    friend, notification`.
- **`backend/api/src/modules/attribution/start-param.ts`:**
  - `START_KINDS`;
  - разбор `c-<код>` (`CLICK`), `_tgr_`, `f-`, `n-`;
  - `parseStartParam`.

  Тот же разбор — у `/start` в боте: `welcome.command.ts` → `auth.enterChannel`.
- **`backend/api/src/modules/broadcasts/segment.ts:29`** — копия `START_KINDS`
  для сегментов рассылок.
- **`backend/api/src/modules/links/links.service.ts`:**
  - `visit(code, visitor, now)` — клик → `this.appLinks.launch(link.platform, c-<клик>)`
    → `{ kind: "redirect", target }`;
  - `publicUrl(code)` — адрес переходника;
  - `create`.
- **`links.repository.ts:97-106`** — статистика: клики, клики за 30 дней,
  запуски — через `account_session.start_kind = 'click'` и
  `link_click.click_id`.
- **Порт ссылок** `backend/api/src/platforms/ports/app-links.ts` —
  `launch(platform, param)`, `chat(platform, param)`.
- **Панель:**
  - `apps/admin/src/api/links.ts` — схемы и запросы;
  - `screens/links/LinksScreen.tsx` — список и мастер «где размещается»;
  - `screens/links/LinkCard.tsx` — карточка `#/links/<код>`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** — по процедуре «Общие файлы» в `tasks/README.md`
   (`prisma migrate dev --create-only` один раз, на отдельной базе):
   - `Link.target` — `String @default("app") @db.VarChar(16)` с комментарием
     `/// куда ведёт: app — Mini App, bot — чат с ботом, landing — лендинг`;
   - `StartKind` += `link` с комментарием `/// прямая ссылка кампании l-<код> (Р95)`;
   - миграция только добавляет: значение перечисления и колонку с
     умолчанием, без переписывания таблиц.
3. **`start-param.ts`:**
   - `l-<код>`: код проверяется тем же `LINK_CODE` из `links/link-code.ts`,
     второго правила кода не заводить;
   - вид `link`, `ref` — код;
   - `START_KINDS` += `"link"`;
   - в `segment.ts` — то же значение (копия списка).
4. **Новый `links/link-targets.ts`** — чистые функции, без Nest и базы:

   ```ts
   export const LINK_TARGETS = ["app", "bot", "landing"] as const;
   export type LinkTarget = (typeof LINK_TARGETS)[number];
   interface Builders { launch(param: string): string | null; chat(param: string): string | null; landingBase: string }
   /** Куда ведёт переходник после клика. */
   export function clickTarget(target: LinkTarget, clickId: string, builders: Builders): string | null;
   /** Прямая ссылка; `null` — у ссылки с сетью её нет или площадку сейчас не собрать. */
   export function directUrl(link: { code: string; target: LinkTarget; network: string | null }, builders: Builders): string | null;
   ```

   Лендинг — `${landingBase}/?c=<клик>` и `${landingBase}/?l=<код>`,
   параметр — `encodeURIComponent`.
5. **`links.service.ts`:**
   - `visit` берёт адрес из `clickTarget` (`launch` и `chat` — через
     `this.appLinks` с `link.platform`, `landingBase` — домен `publicUrl`);
   - вид ссылки (`LinkView`) += `target` и `directUrl`;
   - `create` принимает `target` (по умолчанию `app`);
   - новый `retarget(actor, code, target)` — с правом `links.manage` и
     аудитом `links.retarget` «было → стало».
6. **`links.repository.ts`** — к запускам по кликам добавить прямые:
   - `count(DISTINCT account_id)` сессий с `start_kind = 'link'` и
     `start_ref = <код>`;
   - отдельным полем `directLaunches`.
7. **`admin-links.controller.ts`:**
   - `target` в теле создания — `z.enum(LINK_TARGETS)`, необязательный;
   - `PATCH /api/v1/admin/links/:code` с `{ target }`;
   - в ответах — `target`, `directUrl`, `directLaunches`.
8. **Панель:**
   - **мастер** — шаг «Куда ведёт»: «Mini App» (по умолчанию), «Бот»,
     «Лендинг», с подсказкой;
   - **карточка:**
     - строка «Куда ведёт» с правкой выбором;
     - блок «Прямая ссылка» — адрес и «Скопировать»;
     - подсказка «Без переходника: клики не считаются, только запуски.
       Короче — для поста, описания канала, партнёра»;
     - у ссылки с сетью — строка из «Решений»;
   - **список** — колонка «Запуски» числом «через переходник + прямых»,
     подсказка в заголовке.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Переходник как страницу: диплинк `tg://` — T-0058.
- Конверсии в сети (WP43) и параметры сети на клике.
- Ежедневный отчёт в чат: источник `link` в его разбивку не добавляем.
  Прямые запуски попадут в «неизвестно» до отдельной задачи; строка
  ниже в «Документы».

## Тесты

Первым коммитом.

- **`backend/api/test/start-param.test.ts`:**
  - `l-AbC123` → `{ kind: "link", ref: "AbC123" }`;
  - `l-` и `l-а1` (кириллица) → `unknown`;
  - `c-` разбирается как раньше.
- **`backend/api/test/link-targets.test.ts`:**
  - `clickTarget`:
    - `app` → `launch("c-<клик>")`;
    - `bot` → `chat("c-<клик>")`;
    - `landing` → `<домен>/?c=<клик>`;
  - `directUrl`:
    - `app` → `launch("l-<код>")`;
    - `bot` → `chat("l-<код>")`;
    - `landing` → `<домен>/?l=<код>`;
    - с `network` → `null`;
    - построитель вернул `null` → `null`.
- **`backend/api/test/links.test.ts`** (на подменах, как в нём устроено):
  - `visit` у ссылки с `target: bot` отвечает редиректом на чат;
  - `retarget` пишет аудит, без `links.manage` — отказ;
  - в виде ссылки — `directUrl`.
- **`backend/api/test/links.integration.test.ts`** (`runner: local`, Postgres): запуски — две сессии по
  кликам и одна по `l-<код>` → `launches: 2`, `directLaunches: 1`.
- **`apps/admin/test/links.test.ts`** — разбор ответа с `target`,
  `directUrl: null` и `directLaunches`.

## Аналитика

Касание `link` пишется так же, как `click` (`docs/22-analytics-and-metrics.md`,
события атрибуции). Новых имён событий нет.

## Настройки и окружение

Нет.

## Документы

- **`docs/24-attribution-and-sharing.md`** — цели ссылки, прямая ссылка
  `l-<код>`, почему у ссылки с сетью её нет, раздельные запуски.
- **`docs/21-diagrams.md`** — в ER у `Link` поле `target`, в `StartKind`
  значение `link`.
- **`tasks/inbox.md`** — строка: «ежедневный отчёт — источник `link`
  (прямые ссылки, T-0057) в разбивку по источникам».

## Критерии приёмки

- [ ] У ссылки выбирается цель: Mini App, бот, лендинг; меняется в
  карточке, с аудитом.
- [ ] Переходник ведёт туда, куда указывает цель.
- [ ] У ссылки без сети — прямая ссылка с «Скопировать». Вход по ней
  записывается касанием `link` и считается запуском.
- [ ] У ссылки с сетью прямой ссылки нет, и карточка объясняет почему.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; интеграционные тесты
  — на живом Postgres.

## PR

- **Заголовок:** `feat(api): Цель ссылки и прямые ссылки в бота и Mini App`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЦЕЛЬ ССЫЛКИ И ПРЯМЫЕ ССЫЛКИ**

  Ссылка кампании теперь ведёт туда, куда нужно: в Mini App, в бота или на лендинг. У каждой ссылки без сети есть и прямая — сразу в бота или Mini App, без переходника: короче для поста и описания канала. Клики по прямой не считаются, запуски — да, отдельной цифрой.
  ```
