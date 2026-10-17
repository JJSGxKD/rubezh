---
id: T-0092
title: Пакет proxy-kit — разбор подписки Xray, конфиг спутника, пул узлов
epic: E13
priority: P2
status: in-progress
owner: claude-5 / sonnet-5.5 / high
author: claude-lead2-11
size: M
depends_on: []
zones:
  - packages/proxy-kit/**
  - scripts/test/layer-boundaries.test.ts
shared:
  - tsconfig.json
  - vitest.config.ts
  - pnpm-lock.yaml
  - CLAUDE.md
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0092. Пакет proxy-kit — разбор подписки Xray, конфиг спутника, пул узлов

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0092.json)](README.md#значки-статуса)

## Зачем

Решение пользователя от 13.10.2026 (Р101): исходящие запросы сервера могут ходить
через узлы **подписки Xray** — один адрес, за которым десятки подключений. Модуль
проксирования должен переиспользоваться в других проектах команды, поэтому
вся «умная» часть живёт в отдельном пакете без привязки к «Рубежу». Задача
делает пакет: разбор подписки и ссылок узлов, конфиг контейнера-спутника, пул
узлов с проверкой здоровья и выбором. Бэкенд и контейнер — T-0093.

## Решения

- **Пакет `@bh/proxy-kit`** (`packages/proxy-kit`) не импортирует ничего из
  монорепо, Nest и Prisma — как `packages/fx` (`CLAUDE.md`, «Границы слоёв»).
  Единственная зависимость — `zod` `4.6.4`. Сеть, время и DNS в пакет приходят
  **аргументами** (`fetch`, `now`, `assertAllowed`): внутри нет `Date.now()`,
  `Math.random()` и прямых обращений к сети.
- **Форматы подписки — явный список.** Тело ответа — либо base64 (обычный или
  URL-safe, с `=` или без) от списка ссылок по одной в строке, либо тот же
  список открытым текстом. Clash YAML, sing-box JSON, JSON-массив конфигов
  Xray и SIP008 не поддерживаются: `SubscriptionFormatError` с кодом
  `unsupported_format`.
- **Ссылки узлов — явный список:** `vless://`, `vmess://` (base64-JSON и
  адресная форма `vmess://uuid@host:port?…`), `trojan://`, `ss://` (SIP002,
  SIP002 для 2022-шифров, старая base64-форма). Остальные схемы
  (`hysteria2://`, `hy2://`, `tuic://`, `wireguard://`, `socks://`, `ssr://`) —
  в `skipped` с причиной `unsupported_scheme`.
- **Транспорты:** `tcp`, `ws`, `grpc`, `httpupgrade`, `xhttp`; безопасность
  `none`, `tls`, `reality`. Всё, что мы не умеем, **пропускается с причиной, а
  не угадывается** (Xray 26.x отказался от `allowInsecure`, а общий формат ссылок
  его заменил на `pcs`/`vcn`): `kcp`, `http`/`h2`, `quic`; `headerType=http` у
  `tcp`; VLESS `encryption` кроме `none`; `ech`, `pcs`, `vcn`, `pqv`;
  `allowInsecure=1`/`insecure=1`; плагин `ss://`; `aid` ≠ 0 у VMess; шифры
  вне списка Xray. Одна плохая ссылка не роняет остальные.
- **Секреты ссылок не попадают в ошибки.** Поле `detail` пропуска — имя
  параметра или схема, но никогда не кусок ссылки; то же в тексте
  `SubscriptionFetchError`: адрес подписки секретный целиком, в сообщениях его нет.
- **Спутник — Xray с локальными SOCKS-входами**, по одному на узел, без TUN. Порт
  входа = `basePort + слот`; слот узла стабилен между обновлениями подписки.

## Как сейчас

- Образец пакета, собираемого для бэкенда: `packages/fx` — `package.json`
  (ESM, `exports.source`/`types`/`default`, точные версии), `tsconfig.json`
  (NodeNext, `types: ["node"]`, `rootDir: "src"`), тесты в `packages/fx/test/`.
- Подключение пакета: корневой `tsconfig.json` (`references`, строка 8 — `packages/fx`),
  `vitest.config.ts:33` (алиас на исходник), правило границ слоёв
  `scripts/test/layer-boundaries.test.ts:68-72` (`packages/fx/src`),
  `pnpm-workspace.yaml` берёт `packages/*` сам.
- Vitest собирает `packages/**/test/**/*.test.ts` (`vitest.config.ts:15`).
- Бэкенд пакет ещё не использует; подключение, `Dockerfile` и сборка — T-0093.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»): падают, пока кода нет.
2. **Каркас.** `packages/proxy-kit/package.json` по образцу `packages/fx`
   (`"name": "@bh/proxy-kit"`, `dependencies`: `zod` `4.6.4`; `devDependencies`:
   `@types/node` `22.20.2`), `tsconfig.json` (копия `packages/fx`, комментарий
   поправить), `README.md` (что умеет, пример разбора подписки и сборки
   конфига в 15-20 строк, без слов «Рубеж»). В корневой `tsconfig.json` —
   `{ "path": "packages/proxy-kit" }` после `packages/fx`; в `vitest.config.ts` —
   алиас `@bh/proxy-kit`. `pnpm install`: в коммит идёт записанный им `pnpm-lock.yaml`.
3. **`src/node.ts`** — типы узла:

   ```ts
   export type NodeProtocol = "vless" | "vmess" | "trojan" | "shadowsocks";
   export type NodeNetwork = "tcp" | "ws" | "grpc" | "httpupgrade" | "xhttp";
   export interface NodeTransport { network: NodeNetwork; path?: string; host?: string; serviceName?: string; mode?: string }
   export type NodeSecurity =
     | { kind: "none" }
     | { kind: "tls"; serverName: string; alpn: string[]; fingerprint: string | null }
     | { kind: "reality"; serverName: string; fingerprint: string; publicKey: string; shortId: string; spiderX: string };
   export interface ProxyNode {
     /** 16 hex от sha256(протокол|host|port|secret|транспорт|безопасность): название на ключ не влияет */
     key: string; protocol: NodeProtocol; name: string; country: string | null;
     host: string; port: number;
     /** uuid у vless/vmess, пароль у trojan/shadowsocks */
     secret: string;
     flow: string | null;   // vless
     cipher: string | null; // vmess `scy`, shadowsocks method
     transport: NodeTransport; security: NodeSecurity;
   }
   export type SkipReason = "unsupported_scheme" | "unsupported_transport" | "unsupported_option" | "unsupported_cipher" | "malformed";
   ```

4. **`src/links/{vless,vmess,trojan,shadowsocks}.ts`** и `src/share-link.ts`:
   `parseShareLink(link: string): { ok: true; node: ProxyNode } | { ok: false; reason: SkipReason; detail: string }`.
   Не бросает. Правила:
   - `vless`/`trojan` — `new URL(link)`, не регулярки; повтор параметра — берётся первый;
     имя — фрагмент после `decodeURIComponent` (при ошибке — как есть), ≤ 80 знаков,
     управляющие символы убраны; пустое имя — `host:port`.
   - `vless`: userinfo — UUID (иначе `malformed`); `type` по умолчанию `tcp`; `security`
     по умолчанию `none`; `sni` по умолчанию хост; `reality` без `pbk` — `malformed`;
     `fp` у reality по умолчанию `chrome`; `flow` — пусто или `xtls-rprx-vision`.
   - `trojan`: пароль — userinfo после `decodeURIComponent`, не пуст; `security` по
     умолчанию `tls`.
   - `vmess`: если после схемы есть `@` — адресная форма (параметры как у vless,
     `encryption` ∈ `auto`, `aes-128-gcm`, `chacha20-poly1305`, `none`, по умолчанию
     `auto`); иначе base64-JSON, разбираемый Zod-схемой (`add`, `port` строкой или числом,
     `id`, `aid`, `scy`, `net`, `type`, `host`, `path`, `tls`, `sni`, `alpn`, `fp`, `ps`).
     У `grpc` в JSON `path` — это `serviceName`, `type` — режим; `sni` берётся из
     `sni`, иначе `host`, иначе `add`.
   - `ss`: userinfo с `:` — `метод:пароль` в процентной кодировке (2022-шифры);
     без `:` — base64url от `метод:пароль`; форма без `@` — base64 от
     `метод:пароль@host:port`. Методы: `aes-128-gcm`, `aes-256-gcm`,
     `chacha20-poly1305` (= `chacha20-ietf-poly1305`), `xchacha20-poly1305`
     (= `xchacha20-ietf-poly1305`), `2022-blake3-aes-128-gcm`,
     `2022-blake3-aes-256-gcm`, `2022-blake3-chacha20-poly1305`; прочие —
     `unsupported_cipher`. Порт 1…65535, иначе `malformed`.
5. **`src/country.ts`** — `countryOfName(name: string): string | null`: пара
   региональных индикаторов (U+1F1E6…U+1F1FF) → ISO-код; иначе `[DE]` или `(DE)`
   в начале; иначе `null`. Существование страны не проверяется.
6. **`src/subscription.ts`**:

   ```ts
   export interface SkippedLink { index: number; scheme: string; reason: SkipReason; detail: string }
   export interface SubscriptionParse { format: "base64" | "plain"; nodes: ProxyNode[]; skipped: SkippedLink[]; truncated: boolean }
   export class SubscriptionFormatError extends Error { readonly code: "unsupported_format" | "empty" }
   export function parseSubscription(body: string, options?: { maxLinks?: number }): SubscriptionParse; // maxLinks = 1000
   export interface UserInfo { uploadBytes: number | null; downloadBytes: number | null; totalBytes: number | null; expireUnixSec: number | null }
   export function parseUserInfo(header: string | null): UserInfo | null;          // `Subscription-Userinfo`
   export function parseUpdateIntervalHours(header: string | null): number | null; // `Profile-Update-Interval`, 1…168 или null
   ```

   Признак формата: первая непустая строка содержит `://` — открытый текст, иначе
   пробуем base64. Пустые строки, `#`-комментарии и строки без `://` пропускаются
   молча. Дубликаты (один `key`) схлопываются. Сверх `maxLinks` — `truncated: true`.
   Узлы без ссылок и тело, не похожее ни на то, ни на другое, — ошибка формата.
7. **`src/url-guard.ts`** — защита от SSRF (адрес подписки задаёт человек, а
   запрос идёт из сети сервера):

   ```ts
   export function checkSubscriptionUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: "malformed" | "scheme" | "credentials" | "host" };
   export function isPublicAddress(ip: string): boolean;
   ```

   Только `https:`, без логина и пароля в адресе. Хост не пуст, не `localhost`, не
   `*.localhost`/`*.local`/`*.internal`/`*.lan`, не из одной метки без точки (имена
   сервисов compose: `redis`, `postgres`), а IP-литерал — публичный. Непубличные:
   IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`,
   `192.168/16`, `198.18/15`, `224/4`, `240/4`; IPv6 `::`, `::1`, `fc00::/7`,
   `fe80::/10`, `ff00::/8`, `2001:db8::/32`, а `::ffff:a.b.c.d` проверяется как IPv4.
8. **`src/fetch-subscription.ts`**:

   ```ts
   export interface FetchSubscriptionOptions {
     fetch: typeof fetch;
     /** бросает, если нельзя ходить на этот адрес; зовётся для адреса и для каждого Location */
     assertAllowed: (url: URL) => Promise<void>;
     userAgent?: string;  // по умолчанию "v2rayN/7.0"
     timeoutMs?: number;  // 15_000
     maxBytes?: number;   // 2 MiB, считается по потоку
     maxRedirects?: number; // 3, redirect: "manual"
     signal?: AbortSignal;
   }
   export async function fetchSubscription(url: string, options: FetchSubscriptionOptions): Promise<{ body: string; userInfo: UserInfo | null; updateIntervalHours: number | null }>;
   export class SubscriptionFetchError extends Error { readonly code: "blocked_url" | "http_status" | "too_large" | "timeout" | "network" | "too_many_redirects"; readonly status: number | null }
   ```

   Для адреса и каждого перехода сначала зовётся `checkSubscriptionUrl`, затем
   `assertAllowed`; любой отказ или бросок — `blocked_url`. Ответ не `2xx` —
   `http_status` с кодом ответа; `Location` разбирается относительно текущего адреса.
9. **`src/xray-config.ts`**:

   ```ts
   export interface XrayConfigOptions { basePort: number; slotCount: number; listen: string }
   /** Старые слоты сохраняются; новые узлы берут наименьшие свободные слоты по порядку списка. */
   export function assignSlots(keys: readonly string[], previous: ReadonlyMap<string, number>, slotCount: number): { slots: Map<string, number>; overflow: string[] };
   export function buildXrayConfig(nodes: readonly ProxyNode[], slots: ReadonlyMap<string, number>, options: XrayConfigOptions): Record<string, unknown>;
   ```

   Конфиг: `log` — `{ loglevel: "warning", access: "none" }`; на узел — вход
   `{ tag: "in-<слот>", listen, port: basePort + слот, protocol: "socks", settings: { auth: "noauth", udp: false } }`
   и выход `out-<key>` нужного протокола (vless/vmess — `vnext`, trojan и
   shadowsocks — `servers`, `streamSettings` с `tlsSettings`/`realitySettings`/
   `wsSettings`/`grpcSettings`/`httpupgradeSettings`/`xhttpSettings`, `mux` выключен);
   правило `inboundTag → outboundTag` на каждый вход; выход `block` (`blackhole`) для
   всего остального. Узел без слота в конфиг не входит. Для пустого списка — валидный
   конфиг без входов и только с `block`. Имена полей сверяются с образом Xray в
   T-0093 (`xray run -test`); поэтому все имена полей собраны в одной таблице констант
   в начале файла.
10. **`src/pool.ts`** — пул узлов, время приходит аргументом (мс от эпохи):

    ```ts
    export const POOL_DEFAULTS = { probeIntervalMs: 300_000, retryAfterFailMs: 30_000, maxBackoffMs: 3_600_000, downAfterFailures: 2, latencyAlpha: 0.3 };
    export interface PoolEntry { key: string; country: string | null; state: "unknown" | "healthy" | "down"; failures: number; latencyMs: number | null; lastProbeAt: number | null; nextProbeAt: number }
    export class NodePool {
      constructor(options?: Partial<typeof POOL_DEFAULTS>, restore?: readonly PoolEntry[]);
      sync(nodes: readonly { key: string; country: string | null }[], now: number): void;
      due(now: number): string[];
      record(key: string, result: { ok: true; latencyMs: number } | { ok: false }, now: number): void;
      pick(query: { countries?: readonly string[]; limit: number }): string[];
      snapshot(): PoolEntry[];
    }
    ```

    - `sync`: пропавшие узлы забываются, новые — `unknown` с `nextProbeAt = now`, страна обновляется.
    - `record` успех: `healthy`, `failures = 0`, задержка — скользящее среднее
      (`alpha × новая + (1 − alpha) × прежняя`, первая — как есть), следующая проверка через `probeIntervalMs`.
    - `record` отказ: `failures + 1`; до `downAfterFailures` состояние прежнее, проверка через
      `retryAfterFailMs`; с `downAfterFailures` — `down`, пауза `min(probeIntervalMs × 2^(failures − downAfterFailures), maxBackoffMs)`.
    - `pick`: только `healthy`; при `countries` — только узлы с этой страной (узел без страны
      подходит лишь когда фильтра нет); порядок по задержке, затем по `key`; не больше `limit`.
    - `due`: узлы с `nextProbeAt ≤ now`, по возрастанию `nextProbeAt`, затем по `key`.
11. **`src/index.ts`** — публичный список экспортов; внутренние файлы наружу не торчат.
12. **Граница слоёв.** В `scripts/test/layer-boundaries.test.ts` — правило для
    `packages/proxy-kit/src` по образцу `packages/fx/src`: запрещено
    `/["']@bh\/|["']@nestjs\/|["']@prisma\/|generated\/prisma/`, причина — «пакет
    проксирования переиспользуется в других проектах: ни игры, ни Nest, ни Prisma».
13. **Документы** — раздел «Документы».

Каждый файл короче 300 строк; общие хелперы (base64 с обеими азбуками, разбор
параметров) — в `src/internal/`.

## Чего не трогаем

- `backend/**`, `infra/**`, `apps/**`: подключение, хранение, контейнер и панель — T-0093.
- `packages/fx` — только образец.
- Форматы Clash/sing-box, `hysteria2`, `tuic`, `kcp` — не добавляем «заодно»: отдельное решение.
- Реальные подписки и ключи в фикстурах: только выдуманные (`11111111-1111-4111-8111-111111111111`,
  `example.com`, `203.0.113.10`).

## Сценарий и интерфейс

Нет — пакет без интерфейса.

## Тесты

Первым коммитом. Файлы в `packages/proxy-kit/test/`, фикстуры — в `test/fixtures/`.

- `share-link.test.ts` — по ссылке каждого вида (`vless` reality/ws/grpc/xhttp, `vmess` JSON и
  адресная форма, `trojan`, `ss` трёх форм, `2022-blake3-aes-128-gcm`): поля узла как в ожиданиях;
  IPv6-хост в скобках; имя с процентной кодировкой; **отказы**: `vless` без UUID, порт `0` и `70000`,
  `reality` без `pbk` → `malformed`; `type=kcp` → `unsupported_transport`; `allowInsecure=1`,
  `pcs=…`, `encryption=mlkem…`, `aid=1` → `unsupported_option` с именем параметра в `detail`; `ss` с
  `plugin=obfs-local` → `unsupported_option`; метод `rc4-md5` → `unsupported_cipher`; `detail` не
  содержит ни UUID, ни пароля.
- `subscription.test.ts` — base64 с `=`, без `=` и URL-safe дают один и тот же результат; список
  открытым текстом; `\r\n`; комментарии и пустые строки; `hysteria2://` попадает в `skipped`
  (`unsupported_scheme`), остальные узлы целы; одинаковая ссылка дважды — один узел; смена только
  `#названия` — тот же `key`, смена UUID — другой; 1001 строка → `truncated: true` и 1000 разобранных;
  Clash YAML и JSON → `SubscriptionFormatError("unsupported_format")`; пустое тело → `empty`;
  `parseUserInfo("upload=1; download=2; total=3; expire=4")`, мусор и `null` → `null`;
  `parseUpdateIntervalHours("12")` → 12, `"0"` и `"999"` → `null`.
- `country.test.ts` — `🇩🇪 Берлин #3` → `DE`; `[nl] Amsterdam` → `NL`; `Frankfurt` → `null`.
- `url-guard.test.ts` — `http://…`, `https://u:p@…`, `https://localhost/…`, `https://redis/…`,
  `https://10.0.0.5/…`, `https://[::1]/…`, `https://[::ffff:127.0.0.1]/…`, `https://sub.local/…` →
  отказ с причиной; `https://example.com/sub?token=x`, `https://203.0.113.10/…` → разрешено;
  `isPublicAddress` по границам диапазонов (`172.15.255.255` — да, `172.16.0.0` — нет).
- `fetch-subscription.test.ts` (подмена `fetch`) — 200 с заголовками → тело и разобранные заголовки;
  302 на закрытый адрес → `blocked_url`, второй запрос не сделан; цепочка из 4 переходов →
  `too_many_redirects`; тело 3 МиБ → `too_large` (читается по потоку, не целиком); 403 →
  `http_status` со статусом; зависший ответ → `timeout`; в `message` ошибок адреса нет; в запросе
  `User-Agent`, `redirect: "manual"`.
- `xray-config.test.ts` — золотые конфиги в `test/fixtures/xray/*.json` для шести узлов (vless
  reality tcp с `xtls-rprx-vision`, vless ws tls, vmess ws tls, trojan grpc tls, ss 2022, vless xhttp
  reality); `assignSlots`: прежние слоты сохраняются при смене порядка, ушедший узел освобождает слот,
  новый берёт наименьший свободный, при `slotCount` меньше числа узлов лишние — в `overflow`; у каждого
  входа порт `basePort + слот`; узел без слота в конфиге нет; пустой список даёт валидный конфиг.
- `pool.test.ts` — новый узел `unknown`, в `due` сразу, в `pick` нет; успех → `healthy`, в `pick`;
  один отказ у здорового — всё ещё `healthy`, проверка через `retryAfterFailMs`; второй отказ → `down`,
  из `pick` ушёл; серия отказов растит паузу вдвое до `maxBackoffMs`; успех после `down` возвращает узел;
  `pick` с `countries: ["DE"]` не отдаёт узлы без страны и других стран, без фильтра отдаёт всех;
  порядок по задержке, при равной — по `key`; `limit`; `sync` забывает пропавшие и сохраняет
  состояние оставшихся; `snapshot` → `restore` даёт тот же `pick`.

## Аналитика

Нет: пакет не знает об игроках и деньгах. События и журнал — в T-0093 и T-0060.

## Настройки и окружение

Нет. Значения по умолчанию пакета (`POOL_DEFAULTS`, пределы разбора) — константы в коде;
ключи панели и переменные окружения заводит T-0093.

## Документы

- **`CLAUDE.md`**, «Границы слоёв» — строка: «`proxy-kit` (подписки Xray, конфиг спутника, пул
  узлов) не импортирует ничего из монорепо, Nest и Prisma: его берут в другие проекты». Больше ничего.
- **`docs/21-diagrams.md`** — на схеме пакетов (рядом с узлом `FX`, строка ~1526) узел
  `packages/proxy-kit`, без связей: бэкенд подключит T-0093.
- **`docs/30-configuration-map.md`** — строка: «Прокси: опрос узлов подписки — интервал, порог «лежит»,
  рост паузы, сглаживание задержки» → `packages/proxy-kit/src/pool.ts` → `POOL_DEFAULTS`.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: поддерживаются только «список ссылок» (base64 или текст).
  Если поставщик подписки отдаёт лишь Clash YAML или sing-box JSON, нужна отдельная задача на разбор
  этого формата. Образец подписки с замазанными ключами (оставить схемы и параметры) можно
  приложить в PR фикстурой.
- Подтверждено `claude-lead-1` 13.10.2026: узлы с `allowInsecure`/`pcs`/`ech`, `hysteria2`, `tuic`,
  `kcp` пропускаются, а не подключаются «как получится».
- Принято по умолчанию: имя `@bh/proxy-kit`, каталог `packages/proxy-kit`.

## Критерии приёмки

- [ ] Подписка в обоих форматах разбирается; плохая ссылка уходит в `skipped` с причиной, остальные целы.
- [ ] В ошибках и `detail` нет секретов ссылок и адреса подписки (есть тест).
- [ ] Адрес подписки проходит защиту от закрытых адресов, переходы проверяются заново.
- [ ] `buildXrayConfig` совпадает с золотыми файлами; слоты стабильны между обновлениями.
- [ ] Пул ведёт себя по таблице шага 10; время и случайность только извне.
- [ ] Правило границ слоёв для `packages/proxy-kit/src` есть и проходит; пакет собирается (`pnpm build`).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(proxy-kit): Пакет разбора подписок Xray и пула узлов`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПАКЕТ ПРОКСИРОВАНИЯ ЧЕРЕЗ ПОДПИСКУ XRAY**

  Новый самостоятельный пакет proxy-kit: разбирает подписку Xray (vless, vmess, trojan, shadowsocks), собирает конфиг контейнера-спутника и ведёт пул узлов с проверкой здоровья. Его можно взять в другой проект. Бэкенд и контейнер подключит следующая задача.

  🛠 **Пакет proxy-kit**

  • защита адреса подписки от обращений к закрытым адресам
  • неподдерживаемые ссылки пропускаются с причиной, остальные узлы целы
  ```
