---
id: T-0093
title: Подписка Xray для прокси — хранение, обновление, контейнер Xray, раздел панели
epic: E13
priority: P2
status: ready
owner:
author: claude-lead2-11
size: M
depends_on: [T-0092, T-0065]
zones:
  - backend/api/src/modules/proxies/**
  - backend/api/src/infra/outbound/**
  - backend/api/src/modules/admin/admin-proxy-subscription.controller.ts
  - backend/api/Dockerfile
  - backend/api/tsconfig.json
  - backend/api/test/proxy-subscription.test.ts
  - backend/api/test/proxy-subscription.integration.test.ts
  - infra/prod/compose.yml
  - infra/prod/xray/**
  - packages/proxy-kit/src/xray-config.ts
  - packages/proxy-kit/test/xray-config.test.ts
  - packages/proxy-kit/test/fixtures/xray/**
  - apps/admin/src/api/proxy-subscription.ts
  - apps/admin/src/screens/proxies/**
  - apps/admin/test/proxy-subscription.test.ts
shared:
  - backend/api/package.json
  - pnpm-lock.yaml
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/config/app-config.ts
  - .env.example
  - apps/admin/src/ui/help.ts
  - docs/20-env-and-ports.md
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0093. Подписка Xray для прокси — хранение, обновление, контейнер Xray, раздел панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0093.json)](README.md#значки-статуса) [![T-0092](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0092.json&label=T-0092)](T-0092-proxy-kit-package.md) [![T-0065](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0065.json&label=T-0065)](T-0065-outbound-proxies.md)

## Зачем

Решение пользователя от 13.10.2026 (Р101): к прокси исходящих запросов (T-0065) можно подключить
**адрес подписки Xray** со множеством подключений. Узлы подписки работают как обычные прокси: выбор
по стране и режимам сервисов, перебор после неудачи, запись в журнал. Протоколы VLESS/VMess/Trojan/
Shadowsocks Node сам не говорит, их держит контейнер Xray.

## Решения

- **Разбор, конфиг, пул — пакет `@bh/proxy-kit` (T-0092)**; здесь только бэкенд, контейнер и панель.
- **Контейнер Xray без TUN** (он требует `NET_ADMIN` и заворачивает весь трафик контейнера): на узел
  один локальный SOCKS-вход, порт `XRAY_SOCKS_PORT_BASE + слот`. Для T-0065 узел — обычный прокси
  `socks5://xray:<порт>` без пароля. Порты нигде не публикуются: контейнер в сети `tunnel` (internal)
  вместе с API и больше ни с кем.
- **Одна подписка на систему** (строка `main`). Адрес секретный: шифртекстом `SecretCipher` (Р84),
  назад не показывается, в аудит, журнал запросов и ответы не попадает. Без `SECRETS_ENCRYPTION_KEY`
  не сохранить.
- **Конфиг применяется перезапуском Xray**, а не динамическим API: API пишет `config.json` атомарно
  (временный файл и `rename`) в общий том, скрипт `run.sh` в контейнере раз в 5 с сверяет хеш,
  проверяет новый конфиг `xray run -test` и только потом перезапускает. Битый конфиг не роняет
  работающие узлы.
- **Обновление** — по расписанию и кнопкой. Период = `max(настройка, Profile-Update-Interval
  поставщика)`, потолок 168 ч. Кнопки «Обновить сейчас» и «Проверить узлы» — не чаще раза в минуту.
  Обновление идёт под замком Redis. **Ноль подходящих узлов или ошибка — прежние узлы и конфиг
  остаются**: сбой поставщика не обнуляет работающий пул.
- **Адрес подписки — сервис `proxy.subscription`** клиента исходящих (T-0059), умолчание режима
  `direct_only`: секретный адрес не уходит чужим прокси. В журнале путь всегда `/***` (токены бывают
  короче 24 знаков, и правило T-0059 их не поймает).
- **Защита от SSRF:** `checkSubscriptionUrl` из пакета плюс проверка DNS перед каждым запросом и
  переходом (`dns.lookup(all)`, все адреса публичные, иначе отказ). Права — `proxies.view`/`proxies.edit`
  из T-0065, новых нет.
- **В перебор отдаются не все узлы:** `candidates` лучших здоровых (по задержке, фильтр стран подписки),
  после ручных прокси T-0065. Страна — из названия узла; узлы без страны при фильтре не берутся.
- **Проверка узла** — тот же запрос `https://api.ipify.org?format=json`, что «Проверить» в T-0065.

## Как сейчас

(по спецификациям T-0059, T-0060, T-0065, которые к этому моменту влиты; имена сверь с кодом)

- `backend/api/src/infra/outbound/`: `Outbound.forService`, `OUTBOUND_SERVICES` (`outbound-services.ts`),
  `safePath` (`outbound-path.ts`), `attemptPlan`, умолчания режимов (`outbound-route.ts`), порт
  `OutboundRoutes` (`list()`, `modeOf(service)`), `dispatcherFor(proxy)` с `socks5` через `fetch-socks`.
- `backend/api/src/modules/proxies/`: репозиторий, сервис с аудитом, проверка прокси, реализация
  `OutboundRoutes`; панель — `apps/admin/src/screens/proxies/`.
- `backend/api/src/modules/secrets/secret-cipher.ts` — `SecretCipher.seal/open`, `SealedSecret`.
- Таймер с замком Redis — `modules/fx/fx.refresher.ts` (`LOCK_KEY`, `SET NX PX`).
- `backend/api/Dockerfile:46-84` собирает из монорепо только `packages/fx`; прод — `infra/prod/compose.yml`
  (сети `edge`, `data`; образы с точной версией и digest, `docs/09-ci-cd.md` §12).
- Ключи без релиза — `settings/setting-catalog.ts`, помощник `integer(key, group, title, hint, range, fallback)`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Сначала образ.** `docker buildx imagetools inspect ghcr.io/xtls/xray-core:<тег>`. На 13.10.2026
   последний стабильный тег — `26.9.30` (`26.10.10` помечен pre-release); возьми последний **без**
   пометки pre-release на день работы, digest впиши в `compose.yml`. Проверь, что в образе есть
   `/bin/sh` и `sha256sum` (`docker run --rm --entrypoint sh <образ> -c 'command -v xray sha256sum'`).
   Нет — стоп, вопрос тимлиду. Золотые конфиги T-0092 прогони:
   `docker run --rm -v <каталог fixtures/xray>:/c:ro <образ> run -test -c /c/<файл>.json`. Что Xray
   не принял — правь `packages/proxy-kit/src/xray-config.ts` (таблица констант) и золотые файлы.
   `infra/prod/xray/check-config.sh` повторяет прогон для всех файлов; результат — в описание PR.
3. **Подключение пакета:** `backend/api/package.json` — `@bh/proxy-kit: workspace:*`;
   `backend/api/tsconfig.json` — ссылка; в `backend/api/Dockerfile` рядом со всеми строками про
   `packages/fx` те же для `packages/proxy-kit`; `RUN mkdir -p /xray-config && chown node:node
   /xray-config` до `USER` (именованный том наследует владельца каталога).
4. **Миграция** (после перебазирования на свежий `dev`, `--create-only` один раз):

   ```prisma
   // Подписка Xray для прокси исходящих запросов (Р101, T-0093). Одна строка: key = 'main'.
   model ProxySubscription {
     key            String    @id @db.VarChar(16)
     name           String    @db.VarChar(60)
     /// адрес подписки — шифртекстом SecretCipher
     urlIv          Bytes     @map("url_iv")
     urlTag         Bytes     @map("url_tag")
     urlCt          Bytes     @map("url_ct")
     urlKeyId       String    @map("url_key_id") @db.VarChar(16)
     /// «хост …abcd» — сверить с кабинетом поставщика
     urlHint        String    @map("url_hint") @db.VarChar(80)
     enabled        Boolean
     countries      String[]  @db.VarChar(2)
     lastRefreshAt  DateTime? @map("last_refresh_at") @db.Timestamptz(3)
     lastRefreshOk  Boolean?  @map("last_refresh_ok")
     lastRefreshNote String?  @map("last_refresh_note") @db.VarChar(300)
     providerIntervalHours Int? @map("provider_interval_hours")
     trafficUsedBytes  BigInt? @map("traffic_used_bytes")
     trafficTotalBytes BigInt? @map("traffic_total_bytes")
     expiresAt      DateTime? @map("expires_at") @db.Timestamptz(3)
     updatedBy      String    @map("updated_by") @db.Uuid
     updatedAt      DateTime  @map("updated_at") @db.Timestamptz(3)
     nodes          ProxySubscriptionNode[]
     @@map("proxy_subscription")
   }

   // Секретов узла (UUID, пароль) в базе нет: они только в конфиге Xray и в ответе поставщика.
   model ProxySubscriptionNode {
     subscriptionKey String   @map("subscription_key") @db.VarChar(16)
     nodeKey         String   @map("node_key") @db.VarChar(16)
     slot            Int      @unique
     protocol        String   @db.VarChar(12)
     name            String   @db.VarChar(80)
     country         String?  @db.VarChar(2)
     host            String   @db.VarChar(255)
     state           String   @db.VarChar(8)
     failures        Int
     latencyMs       Int?     @map("latency_ms")
     lastProbeAt     DateTime? @map("last_probe_at") @db.Timestamptz(3)
     nextProbeAt     DateTime @map("next_probe_at") @db.Timestamptz(3)
     subscription    ProxySubscription @relation(fields: [subscriptionKey], references: [key], onDelete: Cascade)
     @@id([subscriptionKey, nodeKey])
     @@map("proxy_subscription_node")
   }
   ```

5. **Окружение** (по `docs/20` §7: `.env.example` → Zod в `app-config.ts` → код; секретов нет, в CI
   ничего не заводить): `XRAY_HOST` (`xray`), `XRAY_SOCKS_PORT_BASE` (`10800`, 1024…65000),
   `XRAY_SLOT_COUNT` (`100`, 1…500), `XRAY_CONFIG_PATH` (`/xray-config/config.json`). Refine:
   `base + count ≤ 65535`.
6. **`infra/outbound/`:** в `OUTBOUND_SERVICES` — `proxy.subscription`; в умолчаниях режимов —
   `direct_only`; `safePath(url, { maskPath?: boolean })` и `SECRET_PATH_SERVICES = ["proxy.subscription"]`:
   для них путь записи `/***`. Если у записи прокси страна обязательна, а у узла `null` — тип
   становится `string | null`.
7. **Ключи панели** в `setting-catalog.ts`, новая группа «Прокси», через `integer(…)`:
   `proxy.subscription.refresh-hours` (1…168, 6; «часа»), `proxy.subscription.candidates` (1…10, 3;
   «узла»), `proxy.subscription.probe-minutes` (1…60, 5; «минуты»).
8. **`modules/proxies/subscription/`** (каждый файл < 300 строк):
   - `subscription.repository.ts` — таблицы выше;
   - `subscription-fetch.ts` — `Outbound.forService("proxy.subscription")` в `fetchSubscription`;
     `assertAllowed` = DNS-проверка по `isPublicAddress`;
   - `xray-config-writer.ts` — порт `ConfigWriter` и файловая реализация: временный файл рядом,
     `rename`, права `0644` (читает другой пользователь контейнера; тайну держит том); нет каталога —
     `SidecarMissingError`;
   - `subscription.sync.ts` — обновление: адрес → fetch → `parseSubscription` → `assignSlots` (старые
     слоты из таблицы) → `buildXrayConfig` → запись → транзакция (узлы upsert, пропавшие удалены,
     строка подписки с итогом, трафиком и сроком) → `pool.sync`. Ошибки — в `lastRefreshNote`
     по таблице текстов (`subscription.messages.ts`, раздел «Сценарий»);
   - `subscription.scheduler.ts` — по образцу `fx.refresher.ts`: тик 30 с, замок
     `proxy-subscription:refresh:lock` (120 с, токен), обновление по сроку, проверки `pool.due(now)`
     по 5 параллельно, но не раньше 20 с после записи конфига (Xray перезапускается); запись состояний
     в таблицу; при смене `probe-minutes` пул пересоздаётся из `snapshot()`; при старте — пул
     из таблицы, а если файла конфига нет — немедленное обновление;
   - `proxy-probe.ts` — запрос из «Решений» через узел. Если проверка T-0065 вшита в метод сервиса,
     вынеси её **отдельным коммитом-рефакторингом** без смены поведения и зови из обоих мест;
   - `subscription-routes.ts` — `list()`: до `candidates` ключей из `pool.pick`, записи
     `{ id: "node:<key>", scheme: "socks5", host: XRAY_HOST, port: base + слот }`, приоритет
     `максимальный ручной + 1 + место`; `enabled = false` — пусто. Реализацию `OutboundRoutes`
     T-0065 дополнить: ручные прокси, затем узлы. После обновления и проверки — тот же сигнал
     сброса кэша, что при правке прокси в T-0065;
   - `subscription.service.ts` — просмотр, сохранение, включение, удаление (на удаление в
     конфиг пишется пустой — как в T-0092; строки узлов каскадом), аудит `proxy_subscription.save`,
     `.refresh`, `.toggle`, `.delete` с названием и подсказкой адреса, без адреса.
9. **`admin-proxy-subscription.controller.ts`** — `/api/v1/admin/proxy-subscription`: `GET /`
   (подписка, узлы, `sidecar: { connected: boolean }`; адреса нет), `PUT /` (название, `url?` — нет =
   прежний, `countries` по `^[A-Z]{2}$` до 10 штук, `enabled`), `DELETE /`, `POST /refresh`,
   `POST /probe`. Чтение — `proxies.view`, остальное — `proxies.edit`. Zod; адрес до записи проходит
   `checkSubscriptionUrl`. Регистрация в `admin.module.ts`.
10. **Контейнер.** `infra/prod/xray/run.sh`:

    ```sh
    #!/bin/sh
    # Запускает Xray и перезапускает его, когда бэкенд записал новый конфиг.
    CONFIG="${XRAY_CONFIG:-/etc/xray/config.json}"
    hash_of() { sha256sum "$CONFIG" 2>/dev/null | cut -d' ' -f1; }
    while [ ! -s "$CONFIG" ]; do echo "xray: жду конфиг"; sleep 5; done
    current="$(hash_of)"; rejected=""
    xray run -c "$CONFIG" & pid=$!
    trap 'kill "$pid" 2>/dev/null; exit 0' TERM INT
    while kill -0 "$pid" 2>/dev/null; do
      sleep 5
      latest="$(hash_of)"
      if [ -n "$latest" ] && [ "$latest" != "$current" ] && [ "$latest" != "$rejected" ]; then
        if xray run -test -c "$CONFIG" >/dev/null 2>&1; then
          echo "xray: конфиг сменился, перезапуск"
          kill "$pid"; wait "$pid" 2>/dev/null
          current="$latest"; xray run -c "$CONFIG" & pid=$!
        else
          echo "xray: новый конфиг не принят, остаюсь на прежнем"; rejected="$latest"
        fi
      fi
    done
    exit 1
    ```

    `compose.yml`: том `xray-config`; сети `tunnel` (`internal: true`) и `tunnel-egress` (выход
    наружу только у Xray); сервис `xray` — образ с версией и digest, `entrypoint: ["/bin/sh",
    "/xray-run.sh"]` (бит исполняемости из Windows не выставить), `./xray/run.sh:/xray-run.sh:ro`,
    `xray-config:/etc/xray:ro`, `restart: unless-stopped`, `read_only: true`, `cap_drop: [ALL]`,
    `security_opt: ["no-new-privileges:true"]`, `mem_limit: 256m`, `logging: *logging`, healthcheck
    `["CMD-SHELL", "pidof xray > /dev/null || exit 1"]`, `networks: [tunnel, tunnel-egress]`. Сервису
    `api` — `xray-config:/xray-config` и сеть `tunnel`. Проверь, что `deploy.sh` ничего больше не
    требует; нужна правка — вопрос тимлиду (файл в зоне T-0085).
11. **Панель** — блок «Подписка Xray» над списком прокси в `apps/admin/src/screens/proxies/`,
    клиент `api/proxy-subscription.ts`, чистые функции в `screens/proxies/subscription-view.ts`
    (`subscriptionUrlProblem`, `trafficLine`, `nodeRows`), пояснение `HELP.proxies.subscription`.
12. **Документы** — раздел «Документы».

## Чего не трогаем

- Ручные прокси, режимы сервисов и сам перебор T-0065, кроме сборки списка (шаг 8) и проверки (шаг 8).
- `deploy.sh` и `scripts/test/deploy-script.test.ts` (T-0085); Caddy, frps, backup.
- Динамический API Xray, несколько подписок, форматы Clash/sing-box (решения тимлида, см. вопросы).
- Конфиг для dev: контейнер там не поднимается, раздел показывает «не подключён».

## Сценарий и интерфейс

Блок «Подписка Xray» (пояснение: «Адрес подписки с множеством подключений. Узлы становятся прокси
для запросов сервера к внешним API»):

- **Загрузка** — как у соседних блоков раздела. **Нет сети** — плашка T-0015 и прежние данные.
- **Пусто** — «Подписка не подключена», кнопка «Подключить подписку». Без ключа шифрования
  вместо кнопки: «Без ключа шифрования адрес подписки сохранить нельзя — задайте SECRETS_ENCRYPTION_KEY
  на сервере».
- **Диалог:** «Название»; «Адрес подписки» (поле скрытое, подсказка «Адрес секретный: после
  сохранения он не показывается»); «Страны узлов» («Коды стран через запятую, например DE, NL.
  Пусто — любые»); «Включена». Адрес проверяется до отправки: не `https`, с логином — «Нужен
  публичный https-адрес без логина и пароля».
- **Подключена** — карточка: название, подсказка адреса, итог («Обновлена 12:40 — 37 узлов,
  пропущено 3 (протокол: 2, транспорт: 1)»), трафик («Осталось 120 ГБ из 500 ГБ · до 01.12.2026»,
  если поставщик сообщил), кнопки «Обновить сейчас», «Проверить узлы», «Изменить», «Отключить»/
  «Включить», «Удалить» (с подтверждением). Таблица узлов: название, протокол, страна, хост, статус
  («Работает», «Не отвечает», «Не проверен»), задержка; рабочие сверху.
- **Ошибки обновления** (`lastRefreshNote`, красным): «Адрес подписки не подходит: нужен публичный
  https-адрес» · «Поставщик ответил кодом 403» · «Поставщик не ответил за 15 секунд» · «Ответ поставщика
  больше 2 МБ» · «Не удалось связаться с поставщиком» · «Формат подписки не поддерживается: нужен список
  ссылок (base64 или текст)» · «Подписка пустая» · «В подписке нет подходящих узлов (пропущено 5)» ·
  «Контейнер Xray не подключён: конфиг некуда записать» · «Не хватило входов: 12 узлов не подключены —
  увеличьте XRAY_SLOT_COUNT». Слишком частое нажатие кнопок — «Подождите минуту».
- **Ограничение аккаунта** — без `proxies.edit` кнопки скрыты, список виден.

## Тесты

Первым коммитом.

- **`backend/api/test/proxy-subscription.test.ts`** (подмены: `fetch`, DNS, `ConfigWriter`, репозиторий, часы):
  - обновление: три узла и `hysteria2://` → конфиг с тремя входами, узлы `unknown`, заметка
    «3 узла, пропущено 1 (протокол: 1)»;
  - ноль подходящих узлов, HTTP 500, формат Clash → прежние узлы и конфиг на месте, `lastRefreshOk = false`,
    в тексте нет адреса подписки;
  - `https://10.0.0.5/s`, `https://redis/s`, DNS отвечает `127.0.0.1`, редирект на закрытый адрес → отказ,
    запрос к цели не сделан;
  - нет каталога конфига → «Контейнер Xray не подключён…»; узлы в таблицу не записаны;
  - слоты: вернувшийся узел получает прежний; новый — наименьший свободный; переполнение — в заметке;
  - `list()` отдаёт не больше `candidates` здоровых, `socks5`, хост `xray`, порт `base + слот`, без логина
    и пароля, ручные впереди; фильтр стран; `enabled = false` — пусто;
  - `safePath` для `proxy.subscription` → `/***`; журнал не содержит query и токена;
  - ручное «Обновить» дважды за минуту → второй отказ; контроллер: без `proxies.edit` — 403, адрес
    `http://…`, с логином, страна `de` → 400, `PUT` без `url` оставляет прежний, ответы и аудит без адреса.
- **`backend/api/test/proxy-subscription.integration.test.ts`** (Postgres, Redis 13): адрес хранится
  шифртекстом и открывается тем же ключом; два параллельных обновления — выполняется одно; `slot` уникален;
  новый экземпляр сервиса восстанавливает пул из таблицы; удаление подписки каскадом убирает узлы.
- **`packages/proxy-kit/test/xray-config.test.ts`** — золотые файлы после правок шага 2.
- **`apps/admin/test/proxy-subscription.test.ts`** — `subscriptionUrlProblem` (http, логин, пусто, ok),
  `trafficLine`, порядок `nodeRows`.
- **Вручную, в PR:** `check-config.sh` зелёный; на сервере или локально контейнер поднят с подписанным
  тестовым конфигом, SOCKS-вход отвечает (`curl --socks5 xray:<порт> https://api.ipify.org`); подмена конфига
  на битый не перезапускает Xray.

## Аналитика

Нет: записи журнала запросов (T-0060) и аудит панели покрывают обновления и обращения. Метрик Prometheus
на бэкенде пока нет, счёт узлов виден в панели.

## Настройки и окружение

Ключи панели и переменные из шагов 5 и 7. Порт `XRAY_SOCKS_PORT_BASE` берётся из карты
(`docs/20` §2): предлагаемая строка «Спутник Xray, SOCKS-входы узлов — `XRAY_SOCKS_PORT_BASE` —
dev `—` — staging `—` — production не публикуется, внутри сети `tunnel` порты 10800–10899».

## Документы

- **`docs/20-env-and-ports.md`** — строка в §2, переменные в §7, в разделе про прод: «Если Xray не принял
  конфиг» (`docker compose logs xray`, прежний конфиг продолжает работать).
- **`docs/21-diagrams.md`** — ER (`proxy_subscription`, `proxy_subscription_node`), поток «подписка → разбор →
  конфиг → том → Xray → SOCKS → клиент исходящих», связь бэкенда с `proxy-kit`.
- **`docs/29-admin-panel.md`** — блок «Подписка Xray» в строке раздела «Прокси».
- **`docs/30-configuration-map.md`** — ключи, переменные, версия образа и места умолчаний.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: **одна** подписка; несколько — отдельной задачей.
- Подтверждено `claude-lead-1` 13.10.2026: порты `10800-10899` под SOCKS-входы (не публикуются), `XRAY_SLOT_COUNT=100`.
- Подтверждено `claude-lead-1` 13.10.2026: фильтр стран один на подписку, а не на сервис (по сервису нужна колонка
  в `outbound_service_mode` из T-0065).
- Подтверждено `claude-lead-1` 13.10.2026: DNS-проверка перед запросом без защиты от подмены между проверкой и
  запросом (подписку задаёт владелец панели).
- Подтверждено `claude-lead-1` 13.10.2026: `User-Agent` подписки `v2rayN/7.0`, настраиваемого поля нет.
- Задача на верхней границе M: панель можно вынести в отдельную (нужен свободный номер).

## Критерии приёмки

- [ ] Подписка подключается, обновляется (по расписанию и кнопкой), включается, удаляется; адреса нигде не видно.
- [ ] Узлы появляются в переборе T-0065 после ручных прокси и попадают в «Запросы» с `via = node:<ключ>`.
- [ ] Сбой поставщика не обнуляет рабочий пул; битый конфиг не роняет Xray.
- [ ] Закрытые адреса и переходы на них отклоняются; `proxy.subscription` по умолчанию `direct_only`.
- [ ] Контейнер: версия и digest, `cap_drop`, `read_only`; сеть `tunnel` без выхода наружу, порты не опубликованы.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Подписка Xray для прокси исходящих запросов`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДПИСКА XRAY ДЛЯ ПРОКСИ**

  В разделе «Прокси» можно подключить адрес подписки Xray. Узлы работают как прокси для запросов сервера к внешним API: выбор по стране и режимам сервисов, перебор после неудачи, журнал. Узлы держит контейнер Xray.

  🛠 **Эксплуатация**

  • новый контейнер xray в compose (версия и digest закреплены), порты наружу не публикуются
  • сбой поставщика подписки не обнуляет рабочие узлы

  ❓ **Нужно от команды**

  • @участник1 — подключить подписку в панели после выкатки и проверить, что узлы «Работают»
  ```
