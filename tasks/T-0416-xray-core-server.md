---
id: T-0416
title: Сервер «Ядра Xray» — запущенная версия, свежий выпуск, совместимость и запуск обновления
epic: E13
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0415, T-0387]
zones:
  - backend/api/src/modules/proxies/xray-core/**
  - backend/api/src/modules/admin/admin-xray-core.controller.ts
  - backend/api/test/xray-core.test.ts
  - backend/api/test/outbound.test.ts
shared:
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/secrets/secret-catalog.ts
  - backend/api/src/infra/outbound/outbound-services.ts
  - backend/api/src/config/app-config.ts
  - .env.example
  - infra/prod/api.env.example
  - apps/admin/src/api/proxies.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/20-env-and-ports.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0416. Сервер «Ядра Xray» — запущенная версия, свежий выпуск, совместимость и запуск обновления

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0416.json)](README.md#значки-статуса) [![T-0415](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0415.json&label=T-0415)](T-0415-xray-core-version-file.md) [![T-0387](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0387.json&label=T-0387)](T-0387-xray-core-fresh-and-transports.md)

## Зачем

Владелец хочет видеть в панели, какая версия Xray крутится на сервере, вышла
ли новее и подойдёт ли она нашему конфигу, и одной кнопкой запускать
обновление через PR (Р202). После задачи у панели есть три ручки: состояние
ядра, «проверить выпуск сейчас» и «обновить» — последняя запускает workflow
GitHub ключом интеграций с минимальными правами. Вкладку рисует T-0418,
workflow — T-0417.

## Решения

- **Р202** (`docs/35-stage4-plan.md`), пункты 1–6. Исполнитель их не
  пересматривает.
- **Запущенная версия** — файл `/xray-status/core` из T-0415 (две строки
  `version=…`, `started=…`). Путь — новая переменная `XRAY_STATUS_PATH`,
  умолчание `/xray-status/core` (не секрет, умолчание допустимо).
  - файла нет (`ENOENT`) — `state: "missing"`: в dev контейнера нет, на
    проде — контейнер старше T-0415 или не запускался;
  - файл есть, `version` не разбирается `parseXrayVersion` — `state:
    "unreadable"`;
  - `started` не разбирается как ISO-время с `Z` — `startedAt: null`, версия
    при этом засчитывается;
  - файл длиннее 1024 байт или ошибка чтения, кроме `ENOENT`, —
    `"unreadable"`.
- **Свежий выпуск** — `GET https://api.github.com/repos/XTLS/Xray-core/releases/latest`
  **без ключа** (пределов анонимного доступа с кэшем на 6 часов хватает с
  запасом), заголовки `accept: application/vnd.github+json`,
  `x-github-api-version: 2022-11-28`, `user-agent: rubezh-api`. Таймаут 5 с.
  - ответ читается Zod-схемой: `tag_name` (строка), `html_url` (строка,
    начинается с `https://github.com/XTLS/Xray-core/`), `published_at`
    (строка-время или `null`), `prerelease`, `draft` (логические);
  - `prerelease` или `draft` — выпуска нет (этот адрес их и так не отдаёт,
    проверка — страховка);
  - `tag_name` не разбирается `parseXrayVersion` — ошибка «Метка выпуска не
    распознана: <первые 32 знака метки>».
- **Кэш выпуска** — Redis:
  - `xray-core:latest` — `{ version, publishedAt, url, checkedAt }`, срок 6 ч;
  - `xray-core:latest:error` — `{ message, at }`, срок 10 мин: сбой GitHub не
    повторяется на каждом открытии вкладки;
  - «Проверить сейчас» — метка `xray-core:refresh:mark` (`SET NX PX 60000`):
    не чаще раза в минуту **на всех**; запрос идёт мимо кэша и переписывает
    его (или ошибку).
  - Redis не ответил за 2 с — чтение кэша считается промахом, запись
    пропускается; вкладка всё равно открывается.
- **Совместимость** — только `xrayCompatibility` из `@bh/proxy-kit` (T-0415):
  у запущенной версии и у свежего выпуска. Своих сравнений версий в бэкенде
  нет — только `parseXrayVersion` и `compareXrayVersions` оттуда.
- **Что запускаем.** `POST https://api.github.com/repos/<репозиторий>/actions/workflows/xray-bump.yml/dispatches`
  с телом `{ "ref": "dev", "inputs": { "version": "<версия>" } }`, заголовок
  `authorization: Bearer <ключ>`. Успех — `204`. Репозиторий, имя файла и
  ветка — константы `XRAY_UPDATE_TARGET` в `xray-core-target.ts`
  (`repository: "JJSGxKD/rubezh"`, `workflow: "xray-bump.yml"`, `ref: "dev"`);
  совпадение имени с файлом workflow сверяет тест T-0417.
- **Ключ интеграций** — `github.xray-update` (Р84), каталог
  `secret-catalog.ts`:
  - `service: "Обновление ядра Xray · GitHub"`;
  - `title: "Токен запуска обновления ядра Xray"`;
  - `hint: "Fine-grained токен GitHub только на репозиторий игры с одним правом — Actions: Read and write (Metadata: Read GitHub добавит сам). Ни содержимого, ни PR: ветку и PR делает сам workflow. Без ключа кнопки «Обновить» во вкладке «Ядро Xray» нет."`;
  - `cabinetUrl: "https://github.com/settings/personal-access-tokens/new"`;
  - `pattern: /^github_pat_[A-Za-z0-9_]{70,120}$/` — только fine-grained:
    классический токен даёт права на все репозитории владельца;
  - `example: "github_pat_11ABCDEFG0aBcDeFgHiJkL_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"`;
  - `fromEnv: () => null` — только из панели, переменной окружения нет;
  - `check` — `keyCheck`: `GET https://api.github.com/repos/<репозиторий>/actions/workflows/xray-bump.yml`
    с `authorization: Bearer`, `x-github-api-version`, `user-agent`;
    `refusalHint: "проверьте, что токен fine-grained, выдан на репозиторий игры и у него право Actions: Read and write"`.
    `404` здесь — тот же отказ (токен не видит файл или файла ещё нет в `main`).
- **Последний запуск** — `GET …/actions/workflows/xray-bump.yml/runs?per_page=1&event=workflow_dispatch`
  тем же ключом, таймаут 5 с, кэш `xray-core:last-run` на 30 с. Схема:
  `workflow_runs[0]` — `status` (строка), `conclusion` (строка или `null`),
  `html_url`, `created_at`, `display_title`. Идущим считается любой `status`,
  кроме `completed`. Нет ключа — запуск не запрашивается (`lastRun: null`).
- **Права**: состояние — `proxies.view`; «Проверить сейчас» и «Обновить» —
  `proxies.edit` (только владелец, Р91). Проверка права — в сервисе
  (`roles.require`), как у остальных ручек прокси, а не только гвардом.
- **Версию к запуску берёт сервер** из своего кэша выпуска. Тело запроса
  несёт `version` только как подтверждение: не совпала с кэшем — отказ «Выпуск
  сменился — обновите страницу». Произвольную версию запустить нельзя.
- **Когда кнопка закрыта** (`blockedBy`, проверяется в этом порядке, первая
  причина и отдаётся):
  1. `no_token` — ключа `github.xray-update` нет;
  2. `no_release` — свежий выпуск не получен;
  3. `blocked` — выпуск в блоке `XRAY_CORE_BLOCKS`;
  4. `older` — выпуск старше `XRAY_CORE_MIN`;
  5. `up_to_date` — запущенная версия разобралась и не старше выпуска;
  6. `in_code` — выпуск не новее `XRAY_CORE_MAX`: версия уже в коде и
     уедет с выпуском;
  7. `running` — последний запуск workflow ещё идёт;
  8. `locked` — замок запуска ещё держится.
  Сервер повторяет эту же проверку в `update` и отказывает с её причиной —
  кнопка в панели не единственная защита.
- **Защита от двойного запуска на сервере** — замок
  `xray-core:update:lock` = `{ accountId, version, at }`, `SET NX PX 600000`,
  **не снимается** после успеха (10 минут — окно, за которое workflow точно
  виден в списке запусков). Снимается только при отказе GitHub с ответом
  (`401`, `403`, `404`, `422`): владелец поправит ключ и нажмёт снова.
  Таймаут или сетевой сбой — замок остаётся: неизвестно, ушёл ли запуск.
  Redis недоступен — запуск не идёт (`503`): без замка не запускаем.
- **Аудит** — `proxies.xray_core.update`, `target` — версия,
  `after: { version, running }` (`running` — запущенная версия или `null`).
  «Проверить сейчас» в аудит не идёт: это чтение.
- **Модуль** — новый `XrayCoreModule` (`proxies/xray-core/xray-core.module.ts`),
  не правка `proxies.module.ts`: `providers` — сервис и его части,
  `exports: [XrayCoreService]`. Подключается в `AdminModule` строкой в
  `imports` — контроллер панели живёт там. Outbound, Redis, ключи
  интеграций и роли — глобальные модули, импортировать их не нужно (сверить
  по `proxies.module.ts`).
- **Исходящие** — новая метка `github.api` в `OUTBOUND_SERVICES`, режим по
  умолчанию — «сначала напрямую». Ту же метку заводит T-0308: если в `dev`
  она уже есть — не дублировать. В коде — буквально
  `outbound.forService("github.api")`, иначе `outbound-sites.test.ts` не
  найдёт использование.

## Как сейчас

- `backend/api/src/modules/proxies/proxies.module.ts` — глобальный модуль
  прокси; образец фабрик с `APP_CONFIG`, `REDIS`, `Outbound`.
- `backend/api/src/modules/proxies/subscription/subscription-lock.ts` —
  `withLock`, метки «не чаще раза в минуту» на `SET NX PX`, таймаут Redis 2 с
  через `withTimeout` (`common/with-timeout.ts`). Образец для замка и метки.
- `backend/api/src/modules/admin/admin-proxy-subscription.controller.ts` —
  образец ручек панели: `AdminSessionGuard`, `PermissionGuard`,
  `@RequirePermission`, `RateLimiter` с `ADMIN_LIMITS.mutate`, разбор тела
  Zod через `parse(...)`, ответ `{ data }`.
- `backend/api/src/modules/secrets/secret-catalog.ts` — `SECRETS`, `keyCheck`
  (строки ~68–92), записи `adsgramRewardSecret` и др. Чтение значения —
  `@Inject(SECRETS_READER) secrets: SecretsReader`, `secrets.get(SECRETS.<ключ>)`.
- `backend/api/src/infra/outbound/outbound-services.ts` — `OUTBOUND_SERVICES`;
  `backend/api/test/outbound.test.ts:170` — полный отсортированный список
  сервисов (`toEqual`), его придётся дополнить.
- `apps/admin/src/api/proxies.ts:137–153` — `SERVICE_TITLES`, подписи
  сервисов в режимах.
- `backend/api/src/config/app-config.ts:215–222` и `:535` — блок переменных
  Xray и сборка `config.xray`.
- `apps/admin/src/api/audit.ts` — подписи действий журнала.
- После T-0415: `@bh/proxy-kit` экспортирует `parseXrayVersion`,
  `compareXrayVersions`, `xrayCompatibility`, `XRAY_CORE_MIN`,
  `XRAY_CORE_MAX`, `XRAY_CORE_BLOCKS`, тип `XrayCompatibility`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Окружение** — по процедуре `docs/20-env-and-ports.md` §7:
   - `app-config.ts`: `XRAY_STATUS_PATH: z.string().trim().min(1).default("/xray-status/core")`
     в блоке Xray, `config.xray.statusPath`;
   - `.env.example` и `infra/prod/api.env.example` — строка с комментарием
     «Файл статуса ядра Xray (Р202): пишет контейнер Xray, API только читает»
     рядом с `XRAY_CONFIG_PATH`.
3. **`proxies/xray-core/xray-core-target.ts`** — константы
   `XRAY_RELEASES_URL`, `XRAY_UPDATE_TARGET`, `GITHUB_HEADERS` (без
   `authorization`), сроки (`LATEST_TTL_MS = 6 * 3_600_000`,
   `ERROR_TTL_MS = 600_000`, `REFRESH_MARK_MS = 60_000`,
   `LAST_RUN_TTL_MS = 30_000`, `UPDATE_LOCK_MS = 600_000`,
   `GITHUB_TIMEOUT_MS = 5_000`, `STATUS_MAX_BYTES = 1_024`).
4. **`xray-core-status.ts`** — чистая `parseCoreStatus(text: string): CoreStatus`
   и `readCoreStatus(path: string, read = readFile): Promise<CoreStatus>`:

   ```ts
   export type CoreStatus =
     | { state: "ok"; version: string; startedAt: Date | null }
     | { state: "missing" }
     | { state: "unreadable" };
   ```

   Строки — `ключ=значение`, лишние ключи и пустые строки пропускаются,
   CRLF допустим. `version` хранится нормализованной (`formatXrayVersion`).
5. **`xray-core-releases.ts`** — класс `XrayReleases` (Redis, `fetch`, часы
   — аргументами конструктора, как в `SubscriptionSync`):
   - `latest(): Promise<{ release: LatestRelease | null; error: string | null }>` —
     кэш, затем запрос; ошибка пишется в `xray-core:latest:error`;
   - `refresh(): Promise<…то же…>` — метка раз в минуту; занята —
     `XrayRefreshTooOftenError` (`429`, «Проверять выпуск можно раз в
     минуту»); мимо кэша.
   - тексты ошибок: «GitHub не ответил за 5 секунд», «GitHub недоступен с
     сервера», «GitHub ответил <код>», «GitHub: слишком много запросов —
     проверим позже» (`403` с `x-ratelimit-remaining: 0` и `429`), «Ответ
     GitHub не разобран», «Метка выпуска не распознана: …».
6. **`xray-core-update.ts`** — класс `XrayCoreUpdater`:
   - `lastRun(token): Promise<{ run: LastRun | null; error: string | null }>`
     с кэшем 30 с;
   - `lockedUntil(): Promise<Date | null>` — по `PTTL` замка;
   - `dispatch(token, version): Promise<void>` — замок, запрос, снятие
     замка только при отказе с ответом, сброс кэша `xray-core:last-run`
     после успеха. Ответы GitHub → ошибки домена:
     - `401`, `403` → `XrayUpdateRefusedError` (`502`), «GitHub не принял
       ключ github.xray-update — проверьте право Actions: Read and write»;
     - `404` → `502`, «Workflow xray-bump.yml не найден: GitHub запускает
       его, только когда файл есть в main»;
     - `422` → `502`, «GitHub отклонил запуск: <message из ответа, до 200
       знаков>»;
     - таймаут → `504`, «GitHub не ответил за 5 секунд — проверьте запуски
       через минуту»;
     - замок занят → `XrayUpdateLockedError` (`409`), «Обновление уже
       запускали в <ЧЧ:ММ по UTC> — повторить можно через 10 минут»;
     - Redis недоступен → `503`, «Не удалось взять замок запуска — повторите
       позже».
7. **`xray-core-errors.ts`** — классы ошибок от `DomainError`
   (`common/domain-error.ts`), коды `xray_*`, тексты из шагов 5, 6 и ниже:
   - `no_token` → `409`, «Нет ключа github.xray-update — задайте его в
     «Ключах интеграций»»;
   - `no_release` → `409`, «Свежий выпуск не получен — проверьте позже»;
   - версия не совпала с кэшем → `409`, «Выпуск сменился — обновите страницу»;
   - `blocked` → `409`, «Перейти нельзя, нужно обновить код: <причина блока>»;
   - `older` → `409`, «Выпуск старше проверенных версий»;
   - `up_to_date` → `409`, «Ядро уже этой версии»;
   - `in_code` → `409`, «Версия уже в коде — уедет с ближайшим выпуском»;
   - `running` → `409`, «Обновление уже идёт — дождитесь конца запуска».
8. **`xray-core.service.ts`** — `XrayCoreService`:
   - `view(actor): Promise<XrayCoreView>` — `proxies.view`;
   - `refresh(actor): Promise<XrayCoreView>` — `proxies.edit`;
   - `update(actor, version: string): Promise<XrayCoreView>` — `proxies.edit`,
     проверка `blockedBy` (кроме `locked` — его решает сам замок), запуск,
     аудит, свежий `view`. Лог — одна строка JSON `{ module: "xray-core",
     event: "update_dispatched", version, actor }`, без ключа.

   ```ts
   export type UpdateBlock = "no_token" | "no_release" | "blocked" | "older" | "up_to_date" | "in_code" | "running" | "locked";
   export interface XrayCoreView {
     running: { state: "ok" | "missing" | "unreadable"; version: string | null; startedAt: string | null; compatibility: XrayCompatibility | null };
     tested: { min: string; max: string };
     latest: { version: string; publishedAt: string | null; url: string; checkedAt: string; compatibility: XrayCompatibility } | null;
     latestError: string | null;
     update: {
       configured: boolean;
       blockedBy: UpdateBlock | null;
       lastRun: { status: string; active: boolean; conclusion: string | null; url: string; createdAt: string; title: string } | null;
       lastRunError: string | null;
       lockedUntil: string | null;
     };
   }
   ```

   Время в ответе — ISO в UTC. Ключ в ответ не попадает ни в каком виде.
   Диапазон и блоки сервис получает необязательным параметром
   `compat?: { min: string; max: string; blocks: readonly XrayCoreBlock[] }`
   (умолчание — константы `proxy-kit`): тесты подменяют его, не трогая пакет.
9. **`xray-core.module.ts`** — по решению «Модуль»; строка в `imports`
   `AdminModule` (`admin.module.ts:92`) и контроллер в его `controllers`.
10. **`admin/admin-xray-core.controller.ts`** — `@Controller("admin/xray-core")`:
    - `GET /` — `proxies.view`;
    - `POST /refresh`, `@HttpCode(200)` — `proxies.edit`, лимит `ADMIN_LIMITS.mutate`;
    - `POST /update`, `@HttpCode(200)` — `proxies.edit`, лимит
      `ADMIN_LIMITS.mutate`, тело `z.strictObject({ version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/) })`,
      ошибка разбора — «Некорректная версия».
11. **Ключ интеграций** `github.xray-update` в `SECRETS` (решение «Ключ
    интеграций»), ключ объекта — `githubXrayUpdate`.
12. **Метка исходящих** `github.api` (решение «Исходящие»):
    `outbound-services.ts` — в список и в комментарий-перечень («`github.api`
    — GitHub: выпуски Xray и запуск обновления ядра (Р202)»);
    `outbound.test.ts` — в ожидаемый список; `apps/admin/src/api/proxies.ts`
    — `"github.api": "GitHub API"` в `SERVICE_TITLES`.
13. **Журнал**: `apps/admin/src/api/audit.ts` — `"proxies.xray_core.update":
    "Запуск обновления ядра Xray"`; строка в `apps/admin/test/audit.test.ts`.
14. **Документы** — раздел «Документы».

## Чего не трогаем

- Вкладку панели — T-0418; workflow `xray-bump.yml` и CI — T-0417.
- `proxies.module.ts`, подписки, узлы, трафик — T-0384…T-0387.
- `infra/prod/compose.yml`, `run.sh`, `Dockerfile` — T-0415.
- Ключ `github.content-bot` и экспорт баланса — T-0308.
- Доступ к Docker с сервера — его нет и не появляется (Р202).

## Тесты

Первым коммитом. `backend/api/test/xray-core.test.ts` — с поддельными
`fetch`, Redis в памяти (как в `proxy-subscription.test.ts`), временным
каталогом для файла статуса и HTTP через Nest, как `proxies.test.ts`:

- **Файл статуса** (`parseCoreStatus`, `readCoreStatus`):
  - `"version=26.10.31\nstarted=2026-11-10T09:15:02Z\n"` → `ok`, `26.10.31`, время;
  - CRLF и лишний ключ `foo=bar` → то же;
  - `version=` пусто или `version=abc` → `unreadable`;
  - `started=вчера` → `ok`, `startedAt: null`;
  - нет файла → `missing`; файл 2 КБ → `unreadable`.
- **Выпуск** (`XrayReleases`):
  - ответ `{ tag_name: "v26.11.5", html_url: "https://github.com/XTLS/Xray-core/releases/tag/v26.11.5", published_at: "…", prerelease: false, draft: false }`
    → `26.11.5`; второй вызов в течение 6 ч — без запроса к сети;
  - запрос — без заголовка `authorization`, с `x-github-api-version` и `user-agent`;
  - `prerelease: true` → выпуска нет; `html_url` на другой репозиторий → ошибка «Ответ GitHub не разобран»;
  - `tag_name: "nightly"` → «Метка выпуска не распознана: nightly»;
  - таймаут → «GitHub не ответил за 5 секунд», ошибка кэшируется на 10 мин:
    повторный `latest()` сеть не трогает;
  - `refresh()` дважды за минуту → второй — `429`; через 61 с (поддельные
    часы или истёкшая метка) — проходит и переписывает кэш;
  - Redis бросает — `latest()` всё равно отвечает (идёт в сеть).
- **Запуск** (`XrayCoreUpdater`, `XrayCoreService.update`), запущенная
  `26.10.31`, `XRAY_CORE_MAX` подменён на `26.10.31` через параметр/фабрику:
  - выпуск `26.11.5`, ключ есть, запусков нет → `POST …/actions/workflows/xray-bump.yml/dispatches`,
    тело `{ ref: "dev", inputs: { version: "26.11.5" } }`, заголовок
    `authorization: Bearer <ключ>`; аудит `proxies.xray_core.update` с
    `{ version: "26.11.5", running: "26.10.31" }`; в логах и ответе ключа нет;
  - тело `{ version: "26.11.6" }` при кэше `26.11.5` → `409` «Выпуск сменился»; запроса к GitHub нет;
  - второй `update` сразу после первого → `409` замка, запрос к GitHub один;
  - GitHub `401` → `502`, замок снят: следующий `update` снова идёт в GitHub;
  - GitHub таймаут → `504`, замок остался;
  - Redis недоступен → `503`, запроса к GitHub нет;
  - последний запуск `status: "in_progress"` → `409` `running`;
  - выпуск в блоке `XRAY_CORE_BLOCKS` (подменённом) → `409` с причиной блока;
  - запущенная = выпуск → `409` `up_to_date`; запущенная `26.10.31`, выпуск
    `26.10.31`, `MAX` `26.10.31` → `up_to_date`; запущенная `26.9.1`, выпуск
    = `MAX` → `in_code`;
  - нет ключа → `409` `no_token`.
- **Состояние** (`view`):
  - порядок `blockedBy` — по одному случаю на каждую причину, и когда
    причин две — отдаётся первая по списку решений;
  - `missing` файла → `running.version: null`, `compatibility: null`;
  - без ключа — `lastRun` не запрашивается, `update.configured: false`;
  - `lockedUntil` — время конца замка по `PTTL`.
- **HTTP** (`AdminXrayCoreController`):
  - `GET /admin/xray-core` с `proxies.view` → `200`, без права → `403`;
  - `POST /update` и `/refresh` с `proxies.view` без `proxies.edit` → `403`;
  - `POST /update` с `{ version: "26.11" }` или лишним полем → `400`;
  - в ответах нет значения ключа (поиск подстроки `github_pat_`).
- **Ключ интеграций** — в `xray-core.test.ts`:
  `secretProblem(SECRETS.githubXrayUpdate, "ghp_…")` — отказ;
  fine-grained нужной длины — проходит; `check` с ответом `200` → `ok`,
  с `404` → не `ok`, текст со словами «Actions: Read and write».
- `backend/api/test/outbound.test.ts` — `github.api` в списке каталога.

## Аналитика

Нет событий игрока: это действие владельца в панели, оно в журнале действий
команды (`proxies.xray_core.update`). Запросы к GitHub видны в журнале
исходящих под меткой `github.api`.

## Настройки и окружение

- Переменная `XRAY_STATUS_PATH` (не секрет, умолчание `/xray-status/core`) —
  шаг 2.
- Ключ интеграций `github.xray-update` — только панель.
- Метка исходящих `github.api`.
- Ключей каталога настроек нет.

## Документы

- `docs/20-env-and-ports.md` — `XRAY_STATUS_PATH` в таблице переменных
  раздела 9.3 рядом с `XRAY_CONFIG_PATH`.
- `docs/30-configuration-map.md` — в конец таблицы своей темы строки:
  `XRAY_STATUS_PATH`; ключ интеграций `github.xray-update` (что даёт, какие
  права токена); сроки кэша выпуска и замка запуска — константы
  `xray-core-target.ts`.

## Критерии приёмки

- [ ] `GET /admin/xray-core` отдаёт запущенную версию из файла, свежий выпуск
      XTLS с кэшем 6 ч, совместимость обеих из `proxy-kit` и состояние кнопки.
- [ ] «Обновить» запускает `xray-bump.yml` на `dev` только версией из кэша
      сервера, только с `proxies.edit`, не чаще одного раза за 10 минут и не
      при идущем запуске; отказ GitHub с ответом снимает замок.
- [ ] Ключ `github.xray-update` — fine-grained, проверка связи показывает,
      какое право нужно; значение не попадает в ответы, логи и аудит.
- [ ] Все запросы к GitHub — через `forService("github.api")` с таймаутом 5 с.
- [ ] Аудит `proxies.xray_core.update` с подписью в панели.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Версия и обновление ядра Xray для панели`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВЕРСИЯ И ОБНОВЛЕНИЕ ЯДРА XRAY ДЛЯ ПАНЕЛИ**

  Сервер знает, какая версия Xray запущена, какой свежий выпуск у XTLS и подойдёт ли он нашему конфигу, и умеет запустить workflow обновления (Р202). Вкладку в панели добавит T-0418.

  🛠 **Сервер**

  • GET /admin/xray-core — версия, выпуск, совместимость, последний запуск
  • POST /admin/xray-core/update — запуск xray-bump.yml, только владелец, не чаще раза в 10 минут
  • новый ключ интеграций github.xray-update, метка исходящих github.api

  ❓ **Нужно от команды**

  • @владелец — когда xray-bump.yml окажется в main, создать fine-grained токен на репозиторий игры с правом Actions: Read and write и вставить в «Ключи интеграций» → github.xray-update
  ```
