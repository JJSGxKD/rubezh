---
id: T-0033
title: Проверка готовности API — /health/ready смотрит базу и Redis
epic: E3
priority: P1
status: done
owner: claude-3 / sonnet-5.5
size: S
depends_on: []
zones:
  - backend/api/src/health/readiness.controller.ts
  - backend/api/src/http-app.ts
  - backend/api/test/readiness.test.ts
  - infra/prod/compose.yml
shared:
  - backend/api/src/app.module.ts
  - docs/20-env-and-ports.md
  - docs/09-ci-cd.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0033. Проверка готовности API — /health/ready смотрит базу и Redis

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0033.json)](README.md#значки-статуса)

## Зачем

`GET /health` отвечает `ok`, ничего не проверяя: процесс жив — значит, ok.
Если отвалилась база или Redis, проба Docker и будущая внешняя проверка
(T-0034) этого не увидят, а игроки получат ошибки. Нужна проверка готовности:
API жив и достаёт до своих хранилищ.

## Решения

- **`/health` остаётся как есть** — проба жизни процесса, без зависимостей.
- **Новый `GET /health/ready`:**
  - `SELECT 1` в Postgres и `PING` в Redis, у каждого таймаут 1 секунда;
  - оба ответили — 200;
  - любой нет — 503.

  Тело в обоих случаях:
  `{ status: "ok" | "degraded", checks: { postgres: "ok" | "fail", redis: "ok" | "fail" } }`.
  Без текста ошибок и адресов: проверка публичная.
- **Публичная, как `/health`** (`@Public()`): её зовут Docker и внешняя
  проверка. Лимит по адресу — 60 в минуту: внешней проверке хватит одного
  запроса в 5 минут, а заваливать базу через неё не выйдет.
- **Проба Docker API в проде переходит на `/health/ready`.** Тогда выкат
  (`deploy.sh`, `docker compose up --wait`) не признает здоровой версию,
  которая не достаёт до базы или Redis, и вернёт прежнюю.
- **Отдельный контроллер** `ReadinessController`, а не метод в
  `HealthController`. Тестам HTTP-слоя, где `HealthController` поднят без базы
  (`test/http-app.test.ts`), зависимости не понадобятся.

## Как сейчас

- `backend/api/src/health/health.controller.ts`:
  - `@Controller("health")`;
  - `@Public() @Get() check()` → `{ status: "ok", timestamp }`.

  Зарегистрирован в `app.module.ts:149` (`controllers: [HealthController]`).
  Префикс `api/v1` к `health` не применяется:
  `app.setGlobalPrefix("api/v1", { exclude: ["health", "r/:code"] })` в
  `http-app.ts`. Исключение совпадает с путём целиком, поэтому `health/ready`
  без новой строки получил бы префикс.
- Prisma — `PrismaService`, Redis — токен `REDIS` (`infra/redis.ts`). Как они
  внедряются в контроллеры, видно, например, по `modules/media`.
- Лимит по адресу — `RateLimiter` и `addressOf`, как в `auth.controller.ts`.
  Если к этому времени T-0022 вынесла `addressOf` в `common/request-address.ts`,
  взять оттуда.
- `infra/prod/compose.yml:58-63` — проба API:
  `fetch('http://127.0.0.1:4000/health')`.

## Шаги по порядку

1. Тест первым коммитом (раздел «Тесты»).
2. **Новый `backend/api/src/health/readiness.controller.ts`:**

   ```ts
   /** Сколько ждать ответа хранилища: проба Docker ждёт 5 секунд, обе проверки идут параллельно. */
   const CHECK_TIMEOUT_MS = 1_000;
   const READY_LIMIT: RateLimit = { scope: "health:ready", limit: 60, windowSec: 60 };

   @Controller("health")
   export class ReadinessController {
     @Public()
     @Get("ready")
     async ready(@Req() request: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<Readiness>;
   }
   ```

   - лимит по адресу — `RateLimitedError`;
   - `Promise.all` двух проверок, каждая — `withTimeout(…, CHECK_TIMEOUT_MS, …)`
     и `catch` → `"fail"`;
   - статус ответа 503 при любом `"fail"`: `reply.status(503)`;
   - тип `Readiness` — в том же файле.

   Комментарий класса — почему проверка отдельно от `/health` и почему без
   текста ошибок.
3. **`app.module.ts`** — `ReadinessController` в `controllers` рядом с
   `HealthController`, одной строкой. **`http-app.ts`** — в `exclude`
   добавить `"health/ready"`: `exclude: ["health", "health/ready", "r/:code"]`,
   комментарий над строкой — «пробы и мониторинг не должны знать о версии API»
   — уже есть.
4. **`infra/prod/compose.yml`** — проба API на `http://127.0.0.1:4000/health/ready`.
   Интервалы и `start_period` не меняются. Комментарий над пробой: «готовность,
   а не жизнь: выкат не признает здоровой версию без базы или Redis».
5. **Документы** — раздел «Документы».

## Чего не трогаем

- `HealthController` и `/health`.
- Пробы Postgres, Redis и Caddy в `compose.yml`.
- `deploy.sh`: он уже ждёт пробу (`docker compose up --wait`).

## Тесты

Первым коммитом, новый `backend/api/test/readiness.test.ts`, HTTP через
`createHttpApp` по образцу `test/http-app.test.ts`, с подменами Prisma и Redis:

- обе подмены отвечают → 200, `{ status: "ok", checks: { postgres: "ok", redis: "ok" } }`;
- Postgres бросает → 503, `postgres: "fail"`, `redis: "ok"`;
- Redis не отвечает дольше секунды → 503, `redis: "fail"` (фальшивые
  таймеры или подмена, которая никогда не резолвится);
- в теле нет текста ошибки;
- маршрут без токена (`@Public`) — не 401;
- путь — `/health/ready`, а `/api/v1/health/ready` → 404;
- 61-й запрос с одного адреса за минуту → 429.

Тест «каждый маршрут объявил гвард или публичность»
(`test/route-permissions.test.ts`) должен остаться зелёным.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/20-env-and-ports.md`, раздел о прод-стеке — строка: «Пробы: `/health` —
  процесс жив; `/health/ready` — достаёт до Postgres и Redis (503, если нет).
  Проба Docker API — готовность, поэтому выкат не признаёт здоровой версию без
  хранилищ».
- `docs/09-ci-cd.md` §10 (выкат и откат) — то же одной строкой.

## Критерии приёмки

- [ ] `/health/ready` отвечает 200 при живых Postgres и Redis и 503, если
  хоть один не ответил за секунду. Ответ без текста ошибок.
- [ ] `/health` не изменился.
- [ ] Проба API в `compose.yml` — `/health/ready`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Проверка готовности /health/ready`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОВЕРКА ГОТОВНОСТИ API**

  У API появилась проверка готовности: /health/ready отвечает «ок», только если API достаёт до базы и Redis. На неё переходит проба Docker, а дальше — внешняя проверка прода.

  🩺 **Что изменилось**

  • /health/ready — 200 или 503 с тем, что именно не отвечает
  • выкат не признаёт здоровой версию, которая не видит базу или Redis, и возвращает прежнюю
  ```
