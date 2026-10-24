---
id: T-0165
title: Гард панели экспортирует AdminModule, счётчик онлайна — один сервис
epic: E4
priority: P2
status: done
owner: claude-1 / sonnet-5.5 / high
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/auth/auth.module.ts
  - backend/api/src/modules/online/**
  - backend/api/test/app-boot.integration.test.ts
  - backend/api/test/online.http.test.ts
shared: []
runner: local
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 2
---

# T-0165. Гард панели экспортирует AdminModule, счётчик онлайна — один сервис

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0165.json)](../README.md#значки-статуса)

## Зачем

Маршрут панели `GET /admin/online` живёт в `OnlineModule`, а `AdminModule` не
отдаёт наружу ни гард, ни сервис сессий панели. Поэтому `OnlineModule` собирает
их заново, со своим хранилищем сессий. Проверка та же, но каждый следующий
модуль с маршрутом панели повторит эту сборку, и копии разойдутся при первой
правке. Заодно `AuthModule` собирает собственный `OnlineService` для отметки
активности, рядом с тем, что собрал `OnlineModule`. Задача сводит оба случая к
одному экземпляру.

## Решения

Из приёмки #375 (T-0147), пункт входящих от 17.10.2026, `claude-lead-1`:

- в `admin.module.ts` — `exports: [AdminSessionGuard, AdminSessionService]`;
- модули с маршрутами панели импортируют `AdminModule`; из `online.module.ts`
  сборка второго экземпляра убирается;
- перед правкой исполнитель проверяет, что цикла импорта модулей нет; если цикл
  есть, он **останавливается и задаёт вопрос** (раздел «Если что-то неясно» в
  `tasks/README.md`), обходов через `forwardRef` не делает;
- `OnlineService` — один экземпляр на приложение: тот, что отмечает активность в
  `AuthGuard`, и тот, что отвечает на пинг и пересчитывает числа.

Проверка цикла, сделанная при написании: `AdminModule` импортирует `AuthModule` и
другие доменные модули (`admin.module.ts:80`), но не `OnlineModule`;
`OnlineModule` импортирует только `AuthModule`. Значит, `OnlineModule →
AdminModule` цикла не создаёт. Исполнитель перепроверяет это на момент работы.

## Как сейчас

- `backend/api/src/modules/admin/admin.module.ts:108–123` — `AdminSessionService`,
  `AdminSessionGuard` и `ADMIN_SESSION_STORE` объявлены в `providers`; `exports:
  [PanelLoginService, RoleConfirmations]` — гарда в нём нет.
- `backend/api/src/modules/online/online.module.ts:23–36` — свои
  `AdminSessionService`, `AdminSessionGuard` и `{ provide: ADMIN_SESSION_STORE,
  useClass: RedisAdminSessionStore }`; комментарий в строках 18–22 объясняет это
  отсутствием экспорта. Там же `OnlineService`, `OnlineJob`, `RateLimiter` и
  `ONLINE_REPOSITORY`.
- `backend/api/src/modules/auth/auth.module.ts:44–50` — провайдер
  `ONLINE_ACTIVITY` собирает второй `new OnlineService(new
  RedisOnlineRepository(redis), settings)`; настроек нет (модуль собран в тесте
  руками) — порта нет, и `AuthGuard` работает как раньше. Комментарий в строках
  26–36 объясняет, почему не импортируется `OnlineModule`: `OnlineModule` сам
  импортирует `AuthModule`, получился бы цикл.
- `backend/api/src/modules/online/online-activity.ts` — порт `ONLINE_ACTIVITY` и
  интерфейс `OnlineActivity`.
- `backend/api/src/modules/online/online.service.ts:49–51` — в экземпляре
  состояние: `lastWarnAt` (не чаще одной строки `warn` в минуту). Два экземпляра
  — два счётчика, поэтому предупреждений может быть вдвое больше.
- `backend/api/src/modules/online/online.job.ts:26` и
  `online.controller.ts:24, 42` — получают `OnlineService` из `OnlineModule`.
- Десятки тестов собирают `AuthModule` руками без настроек
  (`backend/api/test/access-revocations.test.ts:138–142` и ещё около пятнадцати
  файлов в `backend/api/test/`): без `SETTINGS_READER` порт отметки активности
  должен остаться пустым, а модуль — собираться.
- `backend/api/test/app-boot.integration.test.ts` — собирает приложение целиком
  на живых Postgres и Redis (иначе пропуск); в нём связывание модулей и
  проверяется.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`admin.module.ts`:** `exports: [PanelLoginService, RoleConfirmations,
   AdminSessionGuard, AdminSessionService]`. Комментарий над `exports`: гард
   панели закрывает маршруты модулей, у которых контроллер вне `AdminModule`;
   экспортируется вместе с сервисом, потому что `@UseGuards(...)` Nest
   собирает в модуле контроллера (то же объяснение, что у `AuthGuard` в
   `auth.module.ts`).
3. **Общий модуль счётчика.** Новый файл
   `backend/api/src/modules/online/online-core.module.ts`: `ONLINE_REPOSITORY`
   (`RedisOnlineRepository`), `OnlineService`, провайдер `ONLINE_ACTIVITY`
   (тот же экземпляр сервиса, через `useExisting`), `exports` всех трёх.
   Модуль **ничего не импортирует** из `auth` и `admin`: `REDIS`,
   `SETTINGS_READER` и `APP_CONFIG` приходят из глобальных модулей. Так
   `AuthModule` может его импортировать, а цикла с `OnlineModule` нет.
   Требование к сборке без настроек сохраняется: тесты, собирающие
   `AuthModule` без `SETTINGS_READER`, проходят без правок (порт пуст, как
   сейчас). Если способ, при котором это выполнено, требует правки этих
   тестов, — вопрос, а не правка.
4. **`auth.module.ts`:** `imports: [OnlineCoreModule]`, собственный провайдер
   `ONLINE_ACTIVITY` и импорты `OnlineService`/`RedisOnlineRepository`/`REDIS`
   убираются; `exports` не меняется (`ONLINE_ACTIVITY` остаётся в нём,
   реэкспортируя общий). Комментарий модуля (строки 26–36) переписать под новую
   схему, без истории «раньше было иначе».
5. **`online.module.ts`:** `imports: [AuthModule, AdminModule, OnlineCoreModule]`;
   из `providers` убрать `OnlineService`, `ONLINE_REPOSITORY`,
   `AdminSessionService`, `AdminSessionGuard` и `ADMIN_SESSION_STORE` (и
   неиспользуемые импорты); остаются `OnlineJob` и `RateLimiter`. Комментарий
   над модулем: про гард — что он приходит из `AdminModule`, про сервис — из
   `OnlineCoreModule`.
6. Прогнать `pnpm typecheck` из корня (только он проверяет тесты) и убедиться,
   что в графе модулей нет цикла: старт приложения в
   `app-boot.integration.test.ts` падает на нём с понятной ошибкой Nest.

## Чего не трогаем

- Логика `AdminSessionGuard`, `AdminSessionService`, `RedisAdminSessionStore`: их
  поведение и ключи Redis не меняются.
- `AuthGuard` и `OnlineActivity`: узкий порт остаётся как есть.
- Других модулей с маршрутами панели нет (`AdminSessionGuard` в `*.module.ts`
  встречается только в `admin.module.ts` и `online.module.ts`); переносить
  чужие контроллеры не нужно.
- Ключи настроек, пинг, пересчёт, формат ответов: T-0147 сделан.

## Тесты

Пишутся первым коммитом и падают до шагов 2–5.

- `backend/api/test/app-boot.integration.test.ts` (живые Postgres и Redis; без
  них пропуск, поэтому `runner: local`), после существующих проверок:
  - `app.get(OnlineService, { strict: false })` и `app.get(ONLINE_ACTIVITY,
    { strict: false })` — **один и тот же объект**, а не равные;
  - `AdminSessionService`, полученный из `OnlineModule`
    (`app.select(OnlineModule).get(AdminSessionService, { strict: false })`),
    — тот же объект, что из `AdminModule`.
- `backend/api/test/online.http.test.ts` по смыслу не меняется: кейсы «без права
  — 403, с правом — снимок» и «без токена — 401» остаются зелёными. Если файл
  собирает модуль руками и не затронут — в диф он не попадает.
- Все тесты, собирающие `AuthModule` руками, проходят без правок.

## Аналитика

Нет: перестановка провайдеров, поведение для игрока и панели то же.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md` §4.28: если диаграмма или текст под ней называют модуль,
  где собирается `OnlineService`, поправить. Если не называют, без правок.
- `docs/15-engineering-standards.md`: если там описано, как закрыть маршрут
  панели в своём модуле, — одна строка «импортируй `AdminModule`, не собирай
  гард заново»; нет такого раздела — не добавлять.

## Критерии приёмки

- [ ] `AdminModule` экспортирует `AdminSessionGuard` и `AdminSessionService`;
  `online.module.ts` их не объявляет и не объявляет `ADMIN_SESSION_STORE`.
- [ ] В приложении один экземпляр `OnlineService`: гард отмечает активность в том
  же сервисе, что отвечает на пинг.
- [ ] Цикла импорта модулей нет, `forwardRef` не появился.
- [ ] Тесты, собирающие `AuthModule` без настроек, проходят без правок.
- [ ] Права на `GET /admin/online` прежние: без сессии панели и без права
  отказ.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционный тест на живых
  Postgres и Redis зелёные.

## PR

- **Заголовок:** `refactor(online): Один гард панели и один сервис онлайна`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОДИН ГАРД ПАНЕЛИ И ОДИН СЕРВИС ОНЛАЙНА**

  Модуль панели теперь отдаёт гард соседним модулям, и модуль онлайна больше не собирает его копию. Счётчик онлайна собирается один раз и для отметки активности, и для пинга. Поведение для игроков и панели то же.
  ```
