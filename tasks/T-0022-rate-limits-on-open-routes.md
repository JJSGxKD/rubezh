---
id: T-0022
title: Лимиты частоты на маршрутах игрока, где их не было
epic: E4
priority: P1
status: ready
owner:
size: M
depends_on: [T-0021]
zones:
  - backend/api/src/common/request-address.ts
  - backend/api/src/modules/auth/auth.controller.ts
  - backend/api/src/modules/auth/auth-limits.ts
  - backend/api/src/modules/admin/admin-session.controller.ts
  - backend/api/src/modules/roles/roles.controller.ts
  - backend/api/src/modules/roles/tools.controller.ts
  - backend/api/src/modules/roles/roles-limits.ts
  - backend/api/src/modules/runs/runs.controller.ts
  - backend/api/src/modules/runs/runs-limits.ts
  - backend/api/src/modules/ads/ads.controller.ts
  - backend/api/src/modules/ads/adsgram-reward.controller.ts
  - backend/api/test/route-limits.test.ts
shared:
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0022. Лимиты частоты на маршрутах игрока, где их не было

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0022.json)](README.md#значки-статуса) [![T-0021](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0021.json&label=T-0021)](T-0021-remove-duplicate-privileged-routes.md)

## Зачем

По правилам репозитория у каждого маршрута есть лимит частоты
(`docs/15-engineering-standards.md` §8, скилл `new-backend-module`). У
девяти маршрутов его нет. Без лимита скрипт, долбящий маршрут, нагружает
базу и Redis так же, как тысяча игроков, и на волне после поста в канале
это отнимет ресурсы у живых.

## Решения

- **Лимит — по аккаунту, где он есть,** и по адресу, где аккаунта ещё нет: за
  адресом мобильного оператора стоят сотни игроков (`runs-limits.ts`).
- **Числа — с большим запасом над живым игроком.** Лимит отсекает скрипт, а
  не человека.

  | Маршрут | Ключ | Лимит | Область (`scope`) |
  |---|---|---|---|
  | `POST /auth/logout` | адрес | 10 в минуту | `auth:logout` |
  | `POST /auth/logout-all` | аккаунт | 10 в час | `auth:logout-all` |
  | `GET /auth/me` | аккаунт | 120 в час | `auth:me` |
  | `GET /roles/me` | аккаунт | 120 в час | `roles:me` |
  | `GET /tools/access` | аккаунт | 120 в час | `tools:access` |
  | `GET /runs/leaderboard` | аккаунт | 600 в час | `runs:leaderboard` |
  | `GET /runs/me` | аккаунт | 600 в час | `runs:profile` |
  | `GET /ads/networks` | аккаунт | 600 в час | `ads_networks` |
  | `GET /ads/adsgram/reward/:secret/:userId` | адрес — до проверки секрета; id игрока — после | 3000 в час с адреса; 60 в час на игрока | `ads_adsgram_reward_ip`, `ads_adsgram_reward_user` |

  Почему такие числа:
  - `tools/access` и `ads/networks` клиент спрашивает один раз при запуске
    (`app-shell/src/index.tsx:128`, `state/ad-networks.ts`);
  - рейтинг и профиль — при открытии экранов;
  - выход — раз в сессию.
- **Адрес награды AdsGram зовёт сеть, а не игрок,** поэтому лимит в два слоя:
  - по адресу — до сверки секрета: он держит нагрузку, а запас 3000 в час
    покрывает волну наград;
  - по игроку — после сверки: повтор награды одного игрока раз за разом
    упирается в него.

  Числа — константы рядом с маршрутом, поднимаются правкой.
- **Адрес запроса — одной общей функцией.** Сейчас `addressOf` скопирована в
  два контроллера, а третья копия — дефект. Функция уезжает в
  `common/request-address.ts`, отдельным коммитом рефакторинга.
- **Ответ при превышении — тот же, что везде:** `RateLimitedError` → 429,
  `{ error: { code: "rate_limited" } }`.

## Как сейчас

- Механизм — `RateLimiter.consume(rule, key)` (`modules/ingest/rate-limiter.ts`):
  - фиксированное окно скриптом Lua в Redis;
  - при отказе Redis — в памяти процесса;
  - `false` — лимит исчерпан.

  `IngestModule` глобальный, `RateLimiter` можно внедрить в любой контроллер.
- Образец по аккаунту — `RunsController.limit` (`modules/runs/runs.controller.ts`,
  последний метод класса), лимиты — `RUNS_LIMITS` в `runs-limits.ts`.
  Образец по адресу — `AuthController.limit` (`modules/auth/auth.controller.ts:130-133`),
  лимиты — `AUTH_LIMITS` в `auth-limits.ts`.
- `addressOf(request)` — одинаковые копии в `auth.controller.ts:164-168` и
  `admin/admin-session.controller.ts:118-122`. Обе берут `req.ip` Fastify: он
  учитывает доверенные прокси, а сырой заголовок подделывается.
- Маршруты без лимита:
  - `auth.controller.ts:97-117` — `logout` (`@Public`, токен продления в
    теле), `logoutAll` и `me`, оба под `AuthGuard`;
  - `roles/roles.controller.ts` — `me`. После T-0021 в этом контроллере
    останется только он;
  - `roles/tools.controller.ts:14-18` — `access`;
  - `runs/runs.controller.ts:45-54` — `leaderboard` и `me`;
  - `ads/ads.controller.ts:79-84` — `networks`. Лимиты остальных маршрутов
    лежат константами в начале файла;
  - `ads/adsgram-reward.controller.ts:30-41` — `reward`:
    - сверка секрета за постоянное время (`sameSecret`), формат `userId`,
      затем `tasks.confirm`;
    - `@Req()` у метода нет.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Рефакторинг отдельным коммитом, поведение не меняется.** Новый
   `backend/api/src/common/request-address.ts`:

   ```ts
   /** Адрес из `req.ip` Fastify: он учитывает число доверенных прокси, а сырой заголовок подделывается одной строкой. */
   export function addressOf(request: unknown): string;
   ```

   Тело — как в нынешних копиях, но без `as`: проверить, что `request` —
   объект и у него есть строковое поле `ip`:
   `typeof request === "object" && request !== null && "ip" in request && typeof request.ip === "string"`.
   Пустая строка или нет поля — `"unknown"`. Обе копии удалить, контроллеры
   импортируют общую.
3. **`auth-limits.ts`** — `AUTH_LIMITS` получает:
   - `logout: { scope: "auth:logout", limit: 10, windowSec: 60 }`;
   - `logoutAll: { scope: "auth:logout-all", limit: 10, windowSec: 3600 }`;
   - `me: { scope: "auth:me", limit: 120, windowSec: 3600 }`.

   Комментарий файла дополнить: выход — по адресу, потому что аккаунта в
   запросе нет, только токен продления в теле; «выйти везде» и «кто я» — по
   аккаунту.
4. **`auth.controller.ts`:**
   - `logout`: после `ensureEnabled()` — `await this.limit(AUTH_LIMITS.logout, request)`.
     Методу нужен `@Req() request: unknown`;
   - новый приватный `limitAccount(rule: RateLimit, accountId: string)`:
     `consume(rule, accountId)`, при `false` — `RateLimitedError("Слишком часто — попробуйте позже")`;
   - `logoutAll` — `limitAccount(AUTH_LIMITS.logoutAll, accountId)` до
     `logoutEverywhere`;
   - `me` становится `async` — `limitAccount(AUTH_LIMITS.me, accountId)`.
5. **Новый `roles/roles-limits.ts`:**

   ```ts
   export const ROLES_LIMITS: Record<"me" | "toolsAccess", RateLimit> = {
     me: { scope: "roles:me", limit: 120, windowSec: 3600 },
     toolsAccess: { scope: "tools:access", limit: 120, windowSec: 3600 },
   };
   ```

   В комментарии — почему 120: клиент спрашивает доступ к инструментам раз
   при запуске, «свои роли» — инструменты команды.

   `RolesController` и `ToolsController` получают `RateLimiter` в конструктор
   и проверяют лимит по `accountOf(request).accountId` до обращения к сервису.
   Сообщение — «Слишком часто — попробуйте позже».
6. **`runs-limits.ts`** — `RUNS_LIMITS` получает:
   - `leaderboard: { scope: "runs:leaderboard", limit: 600, windowSec: 3600 }`;
   - `profile: { scope: "runs:profile", limit: 600, windowSec: 3600 }`.

   Комментарий: рейтинг и профиль читают при открытии экранов, десять в
   минуту без перерыва живому игроку не нужны.

   В `runs.controller.ts` приватный `limit` получает третий параметр
   `message = "Слишком много забегов — подождите"`. `leaderboard` и `me`
   зовут его с `"Слишком часто — попробуйте позже"`.
7. **`ads.controller.ts`** — константа рядом с остальными:

   ```ts
   /** Сети для SDK клиент спрашивает раз при запуске — потолок с большим запасом. */
   const NETWORKS_LIMIT: RateLimit = { scope: "ads_networks", limit: 600, windowSec: 3600 };
   ```

   `networks` — `await this.limit(NETWORKS_LIMIT, accountId)` первой строкой
   после `accountOf`.
8. **`adsgram-reward.controller.ts`:**
   - константы:

     ```ts
     /** С одного адреса: держит нагрузку до сверки секрета; запас — на волну наград сети. */
     const REWARD_IP_LIMIT: RateLimit = { scope: "ads_adsgram_reward_ip", limit: 3000, windowSec: 3600 };
     /** На игрока: повтор награды одного игрока упирается сюда. */
     const REWARD_USER_LIMIT: RateLimit = { scope: "ads_adsgram_reward_user", limit: 60, windowSec: 3600 };
     ```

   - `RateLimiter` в конструктор, `@Req() request: unknown` в метод;
   - порядок:
     1. лимит по `addressOf(request)`: превышен — `RateLimitedError`;
     2. секрет не задан — `DisabledError`, как сейчас;
     3. секрет неверный — `UnauthorizedError`, как сейчас;
     4. формат `userId` — `ValidationError`, как сейчас;
     5. лимит по `userId`: превышен — `RateLimitedError`, `tasks.confirm` не
        зовётся;
     6. `tasks.confirm`.
   - в комментарий класса — абзац о двух лимитах и почему первый до секрета.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Сам `RateLimiter` и его поведение при отказе Redis.
- Лимиты, которые уже стоят: вход, продление, забеги, реклама, кошелёк.
- `AuthGuard`, `auth.service.ts`, `auth.module.ts` — зона T-0009.
- Маршруты, которые убирает T-0021: эта задача начинается после неё.
- Клиент: на 429 он уже показывает ошибку (`ApiFailure`), правок не нужно.

## Тесты

Первым коммитом. Новый `backend/api/test/route-limits.test.ts`, контроллеры
создаются напрямую (`new XController(...)`), зависимости — подмены:

```ts
class RecordingLimiter {
  readonly calls: { scope: string; key: string }[] = [];
  allow = true;
  async consume(rule: RateLimit, key: string): Promise<boolean> {
    this.calls.push({ scope: rule.scope, key });
    return this.allow;
  }
}
```

Зависимости, которых метод не касается, — пустые объекты, приведённые
`as never`: так уже делают тесты с `as unknown as Redis`. Запрос — объект
`{ ip: "203.0.113.7", account: { accountId, platform: "telegram", platformUserId: "1" } }`:
`accountOf` читает `request.account` (`modules/auth/auth.guard.ts:55-59`).
Сейчас у `AccessTokenClaims` ровно эти три поля (`access-token.ts:34-38`).
Если T-0009 к этому времени добавит поля, подставить и их.

На каждый маршрут из таблицы «Решения» — два кейса:
- лимит пропускает → `calls` равен `[{ scope, key }]` с областью из таблицы и
  ключом — `accountId` или адресом, сервис вызван;
- лимит исчерпан (`allow = false`) → `RateLimitedError`, сервис не вызван.

Для адреса награды AdsGram дополнительно:
- лимит адреса исчерпан, секрет неверный → `RateLimitedError`, а не
  `UnauthorizedError`: лимит стоит раньше;
- секрет неверный, лимит адреса пропускает → `UnauthorizedError`, в `calls`
  только область адреса;
- секрет верный, `userId` `"777"` → `calls` — область адреса, затем
  `{ scope: "ads_adsgram_reward_user", key: "777" }`, `confirm` вызван.

Для `addressOf`:
- `{ ip: "203.0.113.7" }` → `"203.0.113.7"`;
- `{ ip: "" }`, `{}`, `null`, `"строка"` → `"unknown"`.

Существующие тесты `auth`, `runs`, `ads`, `admin` остаются зелёными. В
HTTP-тестах лимит уходит в память: Redis подменён недоступным, а запросов в
них меньше лимитов.

## Аналитика

Нет: новых действий игрока нет, превышение лимита просто отвечает 429.
Метрик ответов HTTP по кодам в бэкенде пока нет. Это эпик E3
(«Эксплуатация»), не эта задача.

## Настройки и окружение

Нет переменных. Новые константы перечислены в разделе «Документы» для карты
конфигурации.

## Документы

`docs/30-configuration-map.md`, рядом со строкой 326 «Лимиты приёма забегов…» —
новые строки в том же формате таблицы, владелец — участник 1:

- «Лимиты входа, продления, выхода и «кто я»» —
  `backend/api/src/modules/auth/auth-limits.ts` → `AUTH_LIMITS`;
- «Лимиты «свои роли» и доступа к инструментам» —
  `backend/api/src/modules/roles/roles-limits.ts` → `ROLES_LIMITS`;
- «Лимит выдачи сетей для SDK» —
  `backend/api/src/modules/ads/ads.controller.ts` → `NETWORKS_LIMIT` (там же
  `OFFER_LIMIT`, `INTERSTITIAL_LIMIT`, `REPORT_LIMIT`);
- «Лимиты адреса награды AdsGram: с адреса и на игрока» —
  `backend/api/src/modules/ads/adsgram-reward.controller.ts` →
  `REWARD_IP_LIMIT`, `REWARD_USER_LIMIT`.

В строке 326 после «Лимиты приёма забегов и листа забега в профиле» дописать
«, рейтинга и профиля».

## Критерии приёмки

- [ ] У каждого маршрута из таблицы «Решения» есть лимит с той областью, ключом
  и числом, что в таблице; превышение отвечает 429 `rate_limited`.
- [ ] У адреса награды AdsGram лимит адреса стоит до сверки секрета, лимит
  игрока — после.
- [ ] `addressOf` — одна функция в `common/request-address.ts`, без `as`;
  копий в контроллерах нет.
- [ ] Рефакторинг `addressOf` — отдельным коммитом от лимитов.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(api): Лимиты частоты на маршрутах без лимита`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛИМИТЫ НА ВСЕХ МАРШРУТАХ ИГРОКА**

  Девять маршрутов сервера работали без ограничения частоты: скрипт мог нагружать базу так же, как тысяча игроков. Теперь у каждого есть лимит с большим запасом над живым игроком.

  🛡 **Что изменилось**

  • выход, «выйти везде», рейтинг, профиль, роли, доступ к инструментам и сети рекламы — лимит по аккаунту или адресу
  • адрес награды AdsGram — два лимита: с адреса до проверки секрета и на игрока после
  • адрес запроса берётся одной общей функцией вместо копий в контроллерах
  ```
