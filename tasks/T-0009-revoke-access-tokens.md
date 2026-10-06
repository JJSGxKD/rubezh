---
id: T-0009
title: Выход везде и блокировка сразу закрывают выданные токены доступа
epic: E4
priority: P1
status: ready
owner:
size: S
depends_on: []
zones:
  - backend/api/src/modules/auth/access-token.ts
  - backend/api/src/modules/auth/access-revocations.ts
  - backend/api/src/modules/auth/auth.guard.ts
  - backend/api/src/modules/auth/auth.service.ts
  - backend/api/src/modules/auth/auth.module.ts
  - backend/api/test/access-revocations.test.ts
  - backend/api/test/auth.test.ts
shared:
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0009. Выход везде и блокировка сразу закрывают выданные токены доступа

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0009.json)](README.md#значки-статуса)

## Зачем

«Выйти везде» и блокировка аккаунта отзывают токены продления, но уже
выданный токен доступа продолжает работать до своего срока (до 15 минут,
`AUTH_ACCESS_TTL_SEC`). После задачи отозванный токен перестаёт приниматься на
следующем же запросе.

## Решения

- **Отзыв по времени, а не по списку токенов.** При «выйти везде» в Redis
  пишется метка `auth:revoked-before:<accountId>` — секунда отзыва, со сроком
  жизни на 60 с дольше токена доступа. Токен, выданный **раньше этой
  секунды**, не принимается.
- **Токен, выданный в ту же секунду, проходит.** Окно меньше секунды, зато нет
  петли «вошёл заново — новый токен тут же отклонён».
- **Блокировка уже зовёт `logoutEverywhere`** (`admin/admin-players.service.ts:160`),
  поэтому отдельно её править не нужно.
- **Если Redis недоступен,** проверка пропускает запрос и пишет
  предупреждение. Без Redis не работают и токены продления, а отказ всем
  запросам из-за кеша хуже 15-минутного окна.
- **Новая зависимость `AccessRevocations` необязательная** (`@Optional()`) в
  `AuthGuard` и `AuthService`. Их собирают вручную или провайдером десятки
  тестовых модулей других областей, и обязательная зависимость уронила бы их
  все. В приложении её всегда даёт `AuthModule`.

## Как сейчас

- `backend/api/src/modules/auth/access-token.ts`:
  - `signAccessToken` ставит `iat` (`setIssuedAt`, строка 66);
  - `verifyAccessToken` разбирает `payload` схемой `claimsSchema` (`sub`,
    `platform`, `platformUserId`) и `iat` наружу не отдаёт;
  - тип `AccessTokenCheck` — `{ ok: true; claims } | { ok: false; reason }`.
- `backend/api/src/modules/auth/auth.guard.ts`: после проверки подписи кладёт
  `request.account = check.claims`.
- `backend/api/src/modules/auth/auth.service.ts:187`: `logoutEverywhere(accountId)`
  → `this.refresh.revokeAll(accountId)`.
- Redis в модулях внедряется как `@Inject(REDIS) redis` из `../../infra/redis.js`
  — образец в `redis-refresh.store.ts`.
- `backend/api/test/auth.test.ts:268–279`: `new AuthGuard(config())` и
  `canActivate` на подменённом контексте.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **`access-token.ts`:**
   - в `claimsSchema` добавить `iat: z.number().int().nonnegative()`;
   - успешный результат `AccessTokenCheck` получает поле `issuedAtSec: number`.
     Остальные потребители `claims` не меняются.
3. **Новый `access-revocations.ts`:**

   ```ts
   @Injectable()
   export class AccessRevocations {
     constructor(@Inject(REDIS) redis: Pick<Redis, "set" | "get">, @Inject(APP_CONFIG) config: AppConfig) {}
     /** Все токены доступа аккаунта, выданные раньше этой секунды, больше не принимаются. */
     async revokeBefore(accountId: string, nowMs: number): Promise<void>;
     /** Токен выдан раньше отзыва. Ошибка Redis — `false` и предупреждение в лог. */
     async isRevoked(accountId: string, issuedAtSec: number): Promise<boolean>;
   }
   ```

   - ключ — `auth:revoked-before:<accountId>`;
   - значение — `Math.floor(nowMs / 1000)`;
   - `EX` = `config.auth.accessTtlSec + 60`;
   - `isRevoked` — `issuedAtSec < значение`; ключа нет — `false`;
   - чтение под таймаутом `withTimeout` (`../../common/with-timeout.js`) на
     500 мс;
   - лог — JSON `{ module: "auth", event: "revocation_check_failed", reason }`
     уровня `warn`.
4. **`auth.guard.ts`:**
   - конструктор — `(@Inject(APP_CONFIG) config, @Optional() private readonly revocations?: AccessRevocations)`;
   - после успешной проверки: если `revocations` есть и
     `await revocations.isRevoked(check.claims.accountId, check.issuedAtSec)` —
     `throw new UnauthorizedError("Сессия завершена — войдите заново")`.
5. **`auth.service.ts`:**
   - последний параметр конструктора — `@Optional() private readonly revocations?: AccessRevocations`;
   - `logoutEverywhere`: сначала `await this.revocations?.revokeBefore(accountId, Date.now())`,
     потом прежний `revokeAll`.
6. **`auth.module.ts`.** `AccessRevocations` — в `providers`.
7. `docs/30-configuration-map.md`, тема «Аккаунты и вход» (или ближайшая к
   `AUTH_ACCESS_TTL_SEC`) — строка: отзыв токенов доступа — ключ Redis
   `auth:revoked-before:*` живёт на 60 с дольше токена доступа, это константа в
   `access-revocations.ts`.
8. Гейт.

## Чего не трогаем

- Срок жизни токенов и токены продления.
- Модуль ограничений и панель: блокировка уже зовёт `logoutEverywhere`.
- Лимиты частоты маршрутов входа — отдельная задача эпика E4.

## Тесты

Первым коммитом.

1. Новый `backend/api/test/access-revocations.test.ts`, на подмене Redis
   (`Map` и функции `set` и `get`):
   - после `revokeBefore(acc, 10_500)` токен с `issuedAtSec = 9` отозван;
     `10` — нет (та же секунда); `11` — нет;
   - ключ ставится с `EX` = `accessTtlSec + 60`;
   - у другого аккаунта ничего не отозвано;
   - `get` бросает → `isRevoked` возвращает `false`, предупреждение записано.
2. `backend/api/test/auth.test.ts`:
   - `verifyAccessToken` возвращает `issuedAtSec`, равный секунде выдачи;
   - `AuthGuard` с `AccessRevocations` на подмене:
     - токен, выданный до отзыва, → 401, текст «Сессия завершена — войдите заново»;
     - выданный после — проходит;
   - `AuthGuard` без `AccessRevocations` (`new AuthGuard(config())`) работает как раньше;
   - `logoutEverywhere` вызывает `revokeBefore` раньше `revokeAll`.

## Аналитика

Нет.

## Настройки и окружение

Нет новых переменных. Срок метки выводится из `AUTH_ACCESS_TTL_SEC`.

## Документы

`docs/30-configuration-map.md` — шаг 7.

## Критерии приёмки

- [ ] После «выйти везде» или блокировки прежний токен доступа отклоняется со следующего запроса.
- [ ] Новый вход после «выйти везде» работает сразу.
- [ ] Сбой Redis не роняет запросы.
- [ ] Ни один существующий тест не пришлось чинить из-за конструктора `AuthGuard` или `AuthService`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(auth): Выход везде сразу закрывает токены доступа`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВЫХОД ВЕЗДЕ СРАЗУ ЗАКРЫВАЕТ ТОКЕНЫ**

  Раньше после блокировки или «выйти везде» уже выданный токен работал ещё до 15 минут. Теперь он отклоняется со следующего запроса.
  ```
