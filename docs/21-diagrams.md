# Схемы: база данных и архитектурные связи

Единственное место, где живут диаграммы проекта. Формат — Mermaid: он
рендерится прямо в GitHub и в редакторах, лежит в git текстом, поэтому
изменения видны в диффе, а не скрыты внутри картинки.

## Правило поддержки

**Схема, отставшая от кода, хуже отсутствующей** — ей верят, а она врёт.
Отсюда требование:

1. Меняется схема БД — **в том же PR** обновляется §1.
2. Меняются связи между пакетами, модулями или сервисами — обновляется §2-§3.
3. Появляется новый значимый поток (новый способ оплаты, новая интеграция) —
   добавляется диаграмма в §4.
4. Проверка входит в подготовку PR (скилл `pre-pr`, шаг 5).

Пока схема БД маленькая, диаграммы ведутся руками. Когда таблиц станет
больше полутора десятков — подключаем генерацию ER-диаграммы из
`schema.prisma` и проверку в CI, что закоммиченная диаграмма совпадает со
сгенерированной. До этого автоматика дороже пользы.

Диаграммы отвечают на вопрос «как связано», а не «как устроено внутри» —
подробности живут в профильных документах, ссылки под каждой схемой.

---

## 1. База данных

### 1.1 Текущая схема (MVP, реализовано)

Соответствует `backend/api/prisma/schema.prisma` на сегодня.

```mermaid
erDiagram
    USER ||--o{ RUN : "совершает"
    USER ||--o{ PURCHASE : "оплачивает"

    USER {
        uuid id PK
        enum platform "telegram|max|vk|web"
        string platformUserId "id на стороне площадки"
        string displayName
        string avatarUrl "nullable"
        string locale "nullable, только telegram и web"
        datetime createdAt
    }

    RUN {
        uuid id PK
        uuid userId FK
        int score
        int durationSec
        int waveReached
        datetime createdAt
    }

    PURCHASE {
        uuid id PK
        uuid userId FK
        string itemId
        enum kind "skin|continue_run|character_unlock|ad_removal_pack|seasonal"
        enum platform
        int priceMinor "в минимальных единицах валюты площадки"
        string transactionId UK
        datetime createdAt
    }
```

Что важно понимать по этой схеме:

- **Аккаунты не связываются между платформами.** Один человек в Telegram и в
  MAX — две разные строки `USER`, уникальность по паре
  `(platform, platformUserId)`. Обоснование — `08-web-and-identity.md` §3.
- **`RUN` — это сырая история** для антифрода и аналитики, а не источник
  чтения лидерборда: лидерборд отдаётся из Redis ZSET, а `RUN` остаётся
  источником истины, из которого ZSET можно перестроить
  (`14-scalability.md` §4.3).
- **`transactionId` уникален** — это ключ идемпотентности платежа
  (`15-engineering-standards.md` §4.1).

### 1.2 Планируемое расширение (недели 3-4, ещё не реализовано)

Модель, к которой идём при переносе авторизации, атрибуции, рекламы и
рефералки (`13-reuse-from-vpnsibcom.md` §4-§7). Приведена, чтобы решения
принимались с оглядкой на целевую картину, а не только на сегодняшнюю.

```mermaid
erDiagram
    USER ||--o{ RUN : "совершает"
    USER ||--o{ PURCHASE : "оплачивает"
    USER ||--o{ SESSION : "открывает"
    USER ||--|| ACQUISITION : "имеет"
    USER ||--o{ EVENT : "порождает"
    USER ||--o{ ADS_VIEW : "смотрит"
    USER ||--o{ REFERRAL : "приглашает"
    USER ||--|| BALANCE : "владеет"
    ADS_BLOCK ||--o{ ADS_VIEW : "показан в"
    ADS_NETWORK ||--o{ ADS_BLOCK : "обслуживает"

    USER {
        uuid id PK
        enum platform
        string platformUserId
        enum role "user|designer|admin"
        datetime createdAt
    }

    SESSION {
        uuid id PK
        uuid userId FK
        string source "из startParam"
        string campaignId
        string ip
        json device "разобранный UA"
        datetime startedAt
    }

    ACQUISITION {
        uuid id PK
        string firstSource "первое касание"
        string lastSource "последнее касание"
        datetime firstAt
        datetime lastAt
    }

    EVENT {
        uuid id PK
        uuid userId FK
        enum eventType "FIRST_RUN|RUN_COMPLETED|FIRST_PURCHASE|AD_REWARD_CLAIMED|D1_RETURN"
        json payload
        datetime createdAt
    }

    ADS_VIEW {
        uuid id PK
        uuid userId FK
        uuid blockId FK
        string sessionKey UK "одноразовый ключ показа"
        decimal reward
        datetime claimedAt "nullable до получения награды"
        datetime createdAt
    }

    ADS_BLOCK {
        uuid id PK
        enum place "TASK|REWARD|BANNER|FULLSCREEN"
        bool showAndroid
        bool showIos
        bool showDesktop
        bool isActive
    }

    ADS_NETWORK {
        string key PK
        bool isActive
        int priority "порядок в fallback-цепочке"
    }

    REFERRAL {
        uuid id PK
        uuid inviterId FK
        uuid referralId FK
        bool isActivated "дошёл до целевой волны"
        datetime createdAt
    }

    BALANCE {
        uuid id PK
        decimal softCurrency "Decimal, никогда Float"
        datetime updatedAt
    }

    CONFIG_VERSION {
        int version PK
        int schemaVersion "совместимость со старыми клиентами"
        json snapshot
        uuid publishedBy
        datetime publishedAt
    }
```

`CONFIG_VERSION` намеренно не связана с `USER` внешним ключом: это
неизменяемый снапшот правил игры, а не пользовательские данные
(`19-content-admin.md` §3).

### 1.3 Привлечение, партнёры и аналитика (проектируется)

Вынесено отдельной диаграммой намеренно: это другой домен со своим циклом
жизни, и смешивать его с игровыми сущностями в одной схеме — путь к
нечитаемой картинке.

```mermaid
erDiagram
    CLICK ||--o| USER : "атрибутирует"
    PARTNER ||--o{ PARTNER_LINK : "владеет"
    PARTNER ||--o{ PROMO_CODE : "владеет"
    PARTNER_LINK ||--o{ CLICK : "порождает"
    PROMO_CODE ||--o{ USER : "привязывает"
    PARTNER ||--o{ PARTNER_ACCRUAL : "получает"
    PAYMENT ||--o| PARTNER_ACCRUAL : "порождает"
    USER ||--o{ SHARE : "создаёт"
    SHARE ||--o{ CLICK : "порождает"
    USER ||--o{ ANALYTICS_EVENT : "порождает"

    CLICK {
        uuid click_id PK
        string code UK "короткий непредсказуемый"
        string utmSource
        string utmCampaign
        string referer
        string ip "усекается по истечении срока"
        string userAgent
        uuid refId "nullable"
        uuid partnerId "nullable"
        uuid shareId "nullable"
        datetime createdAt
        datetime boundAt "когда связан с игроком"
    }

    PARTNER {
        uuid id PK
        string telegramId UK
        enum payoutModel "REVSHARE|CPA_FTD|HYBRID"
        decimal revsharePercent
        int holdDays
        bool isBlocked
        datetime createdAt
    }

    PARTNER_LINK {
        uuid id PK
        uuid partnerId FK
        string code UK
        string campaign
        datetime createdAt
    }

    PROMO_CODE {
        uuid id PK
        uuid partnerId FK
        string code UK
        int activationLimit
        datetime expiresAt
    }

    PARTNER_ACCRUAL {
        uuid id PK
        uuid partnerId FK
        uuid paymentId FK
        decimal amount "Decimal, не Float"
        enum status "HELD|PAYABLE|PAID|CANCELLED"
        datetime holdUntil
    }

    SHARE {
        uuid id PK
        uuid userId FK
        enum kind "RUN_RESULT|PROFILE_CARD"
        string variant "оформление карточки, для A/B"
        enum channel "CHAT|STORY|WALL|WEB_SHARE"
        string code UK "своя ссылка на каждый шеринг"
        datetime createdAt
    }

    ANALYTICS_EVENT {
        uuid event_id PK
        string event_type "только из словаря"
        int schema_version
        uuid userId "nullable"
        json attribution "снимок на момент события"
        json payload
        datetime occurred_at
        datetime received_at
    }
```

Три решения, которые из схемы не очевидны:

- **`CLICK` существует до пользователя.** Строка создаётся в момент клика,
  когда игрока ещё нет; `boundAt` заполняется при первом запуске.
- **`ANALYTICS_EVENT.attribution` — снимок, а не ссылка.** Иначе
  перепривязка задним числом переписывает историю и отчёт за прошлый месяц
  перестаёт воспроизводиться (`22-analytics-and-metrics.md` §3.1).
- **У каждого шеринга своя ссылка.** `SHARE.code` — отдельный код на каждый
  шеринг, а не общая реферальная ссылка игрока: только так измеряется, что
  конвертит лучше (`24-attribution-and-sharing.md` §7.3).

---

## 2. Пакеты монорепо и направления зависимостей

Стрелка означает «импортирует». Красных стрелок здесь быть не может — правила
проверяются линтом и строгой раскладкой `node_modules`
(`15-engineering-standards.md` §2.2, `16-tech-stack-decisions.md` §2.2).

```mermaid
flowchart TD
    subgraph apps["apps/ — сборки под платформы (Vite --mode)"]
        WT["web-telegram"]
        WM["web-max"]
        WV["web-vk"]
    end

    subgraph adapters["packages/adapter-* — платформенный слой"]
        AT["adapter-telegram"]
        AM["adapter-max"]
        AV["adapter-vk"]
    end

    CG["packages/core-game<br/>игровой цикл + content/*"]
    ST["packages/shared-types<br/>контракты, лист графа"]
    API["backend/api<br/>NestJS"]

    WT --> CG
    WT --> AT
    WM --> CG
    WM --> AM
    WV --> CG
    WV --> AV

    AT --> ST
    AM --> ST
    AV --> ST
    CG --> ST
    API --> ST
```

Чего на схеме **нет** и не должно появиться:

- стрелки из `core-game` в любой `adapter-*` — иначе движок становится
  платформозависимым и порт на MAX превращается в переписывание;
- стрелки между адаптерами — общее выносится в `shared-types`;
- стрелки из `core-game` в `backend/api` — игровой цикл работает офлайн;
- любых стрелок **из** `shared-types` — это лист графа.

### 2.1 Внутреннее устройство core-game

Ключевая граница внутри пакета — между симуляцией и отрисовкой. Симуляция
обязана запускаться headless: без этого невозможны ни golden-прогоны баланса,
ни воспроизведение бага по seed'у, ни серверная перепроверка забега
(`17-testing-strategy.md` §3). Проверяется тестом по исходникам, а не только
на ревью.

```mermaid
flowchart TD
    subgraph headless["Работает без браузера и Phaser"]
        SIM["game/sim/*<br/>мир, шаг, спавн, сетка, ГПСЧ"]
        PAT["game/patterns/*<br/>поведение врагов"]
        CNT["content/*<br/>враги, волны, апгрейды"]
    end

    subgraph rendered["Требует Phaser"]
        MS["game/MainScene"]
        BS["game/BenchScene<br/>только dev, отдельный чанк"]
        WR["game/render/WorldRenderer"]
    end

    BM["game/bench/*<br/>метрики кадра, вердикт, автопилот,<br/>детектор просадки, отправка отчёта"]

    PAT --> SIM
    SIM --> CNT
    MS --> SIM
    MS --> WR
    BS --> SIM
    BS --> WR
    BS --> BM
    WR --> SIM
```

Чего на схеме нет и не должно появиться:

- стрелок из `game/sim/*` и `game/patterns/*` в Phaser, DOM или `bench/*` —
  симуляция ничего не знает о том, что её рисуют и замеряют;
- стрелок из `content/*` куда бы то ни было в `game/*` — контент это данные;
- `BenchScene` в основном бандле: сцена подключается динамическим импортом,
  иначе стенд испытаний уезжает игрокам.

---

## 3. Бэкенд: модули и инфраструктура

```mermaid
flowchart LR
    subgraph clients["Клиенты"]
        TG["Telegram Mini App"]
        MAX["MAX"]
        VK["VK"]
        ADMIN["Админка<br/>геймдизайнера"]
    end

    CADDY["Caddy<br/>TLS, единственный вход"]

    subgraph api["backend/api"]
        AUTH["auth<br/>initData → JWT"]
        RUNS["runs<br/>приём забегов, антифрод"]
        LB["leaderboard"]
        PAY["payments"]
        ADS["ads<br/>сессии показа, награды"]
        REF["referrals"]
        CONTENT["content<br/>версии конфигурации"]
        BENCH["bench-reports<br/>приём отчётов испытаний<br/>инструмент недели 1, не продукт"]
    end

    subgraph infra["Инфраструктура"]
        PG[("PostgreSQL<br/>источник истины")]
        REDIS[("Redis<br/>кеш, локи, ZSET, очереди")]
        QUEUE["BullMQ<br/>воркеры"]
    end

    CDN["CDN<br/>статика игры + снапшоты конфигурации"]

    TG --> CADDY
    MAX --> CADDY
    VK --> CADDY
    ADMIN --> CADDY

    CADDY --> AUTH
    CADDY --> RUNS
    CADDY --> LB
    CADDY --> PAY
    CADDY --> ADS
    CADDY --> REF
    CADDY --> CONTENT

    AUTH --> PG
    AUTH --> REDIS
    RUNS --> REDIS
    RUNS --> QUEUE
    LB --> REDIS
    PAY --> QUEUE
    ADS --> REDIS
    REF --> PG
    CONTENT --> PG
    CONTENT --> CDN

    QUEUE --> PG
    QUEUE --> REDIS

    TG -.статика и конфиг.-> CDN
```

Читается так: **горячий путь не ходит в Postgres напрямую.** Приём забега
пишет в Redis и ставит задачу в очередь, а запись в БД делает воркер —
поэтому ответ игроку не ждёт диска (`14-scalability.md` §4.1).

---

## 4. Ключевые потоки

### 4.1 Авторизация

```mermaid
sequenceDiagram
    participant C as Клиент (Mini App)
    participant A as auth
    participant R as Redis
    participant DB as PostgreSQL

    C->>A: POST /api/v1/auth/telegram { initData }
    A->>A: Проверка подписи токеном бота<br/>+ явное окно свежести
    alt подпись неверна или initData просрочен
        A-->>C: 401
    else
        A->>DB: найти или создать пользователя<br/>по (platform, platformUserId)
        A->>R: сохранить refresh (jti → userId, TTL)
        A-->>C: access + refresh, профиль
        A->>A: запись сессии и атрибуции → очередь
    end
```

Валидация подписи — **только на сервере**. Детали и краевые случаи —
`13-reuse-from-vpnsibcom.md` §4.

### 4.2 Сдача результата забега

```mermaid
sequenceDiagram
    participant C as Клиент
    participant RU as runs
    participant R as Redis
    participant Q as BullMQ
    participant DB as PostgreSQL

    C->>RU: POST /api/v1/runs { runId, score, wave, duration }
    RU->>R: SET NX runId (идемпотентность)
    alt runId уже был
        RU-->>C: результат первой обработки
    else
        RU->>RU: антифрод: границы score/время/волна
        RU->>R: ZADD lb:{platform}:{season}:{mode}
        RU-->>C: место в лидерборде (сразу)
        RU->>Q: задача «записать забег»
        Q->>DB: INSERT run (батчем), начисления, события
    end
```

Игрок видит результат немедленно, БД догоняет. Идемпотентность — по
клиентскому `runId`, **не** по хэшу тела: два честных забега с одинаковым
счётом дали бы одинаковый хэш (`15-engineering-standards.md` §4.1).

### 4.3 Награда за просмотр рекламы

```mermaid
sequenceDiagram
    participant C as Клиент
    participant AD as ads
    participant R as Redis
    participant N as Рекламная сеть
    participant DB as PostgreSQL

    C->>AD: GET /api/v1/ads/{place}
    AD->>DB: выбрать блок по платформе и месту
    AD->>R: создать сессию показа (meta, TTL)
    AD-->>C: подписанный одноразовый ключ + параметры блока
    C->>N: показ рекламы
    N-->>C: просмотр завершён
    C->>AD: POST /api/v1/ads/confirm { ключ }
    AD->>R: SET NX used:{sid} — атомарно
    alt ключ уже использован или чужой
        AD-->>C: отказ
    else
        AD->>DB: начислить награду в транзакции
        AD-->>C: награда
    end
```

Проверка «использована ли сессия» и начисление — **одна атомарная операция**.
Иначе два параллельных `confirm` оба проходят проверку и награда начисляется
дважды (`13-reuse-from-vpnsibcom.md` §5).

### 4.4 Публикация конфигурации из админки

```mermaid
flowchart TD
    D["Геймдизайнер правит<br/>черновик в админке"]
    V{"Валидация Zod<br/>+ ссылочная целостность"}
    S{"Прогон golden-сценариев<br/>на черновике"}
    DELTA["Показать дельту:<br/>волны, счёт, время до смерти"]
    STG["Публикация в staging"]
    CHECK["Проверка глазами<br/>в реальном клиенте"]
    PROD["Публикация в production<br/>версия N+1"]
    ROLL["Постепенный выкат<br/>10% → 50% → 100%"]
    BACK["Откат на версию N<br/>одним действием"]

    D --> V
    V -- "ошибка" --> D
    V -- "ок" --> S
    S --> DELTA
    DELTA -- "не то, что задумано" --> D
    DELTA -- "ожидаемо" --> STG
    STG --> CHECK
    CHECK --> PROD
    PROD --> ROLL
    ROLL -- "метрики просели" --> BACK
```

Подробности и рамки — `19-content-admin.md`.

### 4.5 Путь атрибуции: от клика до игрока

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant R as Редирект-страница
    participant DB as PostgreSQL
    participant P as Платформа (Telegram/MAX/VK)
    participant API as Бэкенд

    U->>R: GET /r/{code} с UTM-метками
    R->>R: собрать UA, IP, Referer, язык, время
    R--)DB: записать CLICK (асинхронно)
    alt прямая ссылка
        R-->>U: редирект в платформу с click_id
    else через хаб
        R-->>U: страница с кнопками платформ
        U->>R: выбор платформы
        R-->>U: редирект с тем же click_id
    end
    U->>P: запуск Mini App
    P->>API: авторизация + startParam = click_id
    API->>DB: найти CLICK, проверить срок жизни
    API->>API: правила приоритета атрибуции
    API->>DB: заполнить слот источника, SESSION, ACQUISITION
    API--)DB: события app_first_open, user_registered
```

Краулер мессенджера, запрашивающий превью ссылки, кликом **не считается** —
иначе одна отправка в чат порождает фантомный клик и занижает конверсию
(`24-attribution-and-sharing.md` §3.3).

### 4.6 Аналитический конвейер

```mermaid
flowchart LR
    MOD["Модули бэкенда<br/>и клиент"]
    EMIT["Эмиттер событий"]
    Q["BullMQ"]
    RD[("Redis<br/>живые счётчики")]
    W["Воркер<br/>батч-вставка"]
    PG[("PostgreSQL<br/>сырые события")]
    ROLL["Крон пересчёта<br/>витрин"]
    MART[("Витрины<br/>mart_*")]
    REPL[("Read-реплика")]
    PROM["Prometheus"]
    GRAF["Grafana"]

    MOD --> EMIT
    EMIT --> Q
    EMIT --> RD
    Q --> W
    W --> PG
    PG --> ROLL
    ROLL --> MART
    PG -.репликация.-> REPL
    MART -.репликация.-> REPL
    RD --> PROM
    PROM --> GRAF
    REPL --> GRAF
```

Существенное: **Grafana не ходит в горячие таблицы.** Живые панели читают
Prometheus, всё остальное — витрины на реплике. Иначе открытый на стене
дашборд с автообновлением становится постоянной паразитной нагрузкой на ту
же БД, которая принимает забеги (`22-analytics-and-metrics.md` §1).

---

## 5. Топология развёртывания

```mermaid
flowchart TB
    subgraph dev["Локальная разработка"]
        DV["Vite dev-серверы<br/>5173 / 5174 / 5175"]
        DA["API :4000"]
        DPG[("Postgres<br/>127.0.0.1:5432")]
        DR[("Redis<br/>127.0.0.1:6379")]
        DV --> DA
        DA --> DPG
        DA --> DR
    end

    subgraph vps["VPS — production и staging рядом"]
        CAD["Caddy :80 / :443<br/>единственный вход"]

        subgraph prod["compose-проект production"]
            PAPI["API<br/>порт не публикуется"]
            PPG[("Postgres")]
            PR[("Redis")]
            PW["Воркеры BullMQ"]
        end

        subgraph stg["compose-проект staging"]
            SAPI["API :4100 (127.0.0.1)"]
            SPG[("Postgres :5532")]
            SR[("Redis :6479")]
        end

        MON["Prometheus + Grafana"]
        BAK["pg-backup<br/>каждые 6 часов → Telegram"]

        CAD --> PAPI
        CAD --> SAPI
        PAPI --> PPG
        PAPI --> PR
        PW --> PPG
        PW --> PR
        SAPI --> SPG
        SAPI --> SR
        MON -.метрики.-> PAPI
        BAK -.дамп.-> PPG
    end

    CDNP["CDN: статика игры<br/>+ снапшоты конфигурации"]
    PLAYER(("Игрок"))

    PLAYER --> CDNP
    PLAYER --> CAD
```

Порты, смещения staging и правила публикации — `20-env-and-ports.md` §2.
Этапы, на которых эта топология меняется при росте нагрузки, — 
`14-scalability.md` §3.
