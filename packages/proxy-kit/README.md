# @bh/proxy-kit

Исходящие запросы сервера через узлы подписки Xray: разбор подписки и ссылок
узлов, защита адреса подписки от SSRF, загрузка подписки, конфиг контейнера-спутника
и пул узлов с проверкой здоровья. Пакет самостоятельный: ничего из монорепо,
Nest и Prisma; сеть, время и DNS приходят аргументами.

## Что умеет

- Версия ядра Xray: разбор, сравнение, диапазон проверенных версий и блоки
  (`xray-core.ts`, Р202).
- Подписка: base64 (обычный или URL-safe, с `=` или без) либо открытый текст со
  списком ссылок, либо JSON Xray — массив полных конфигов `[{ remarks, outbounds }]`
  или один конфиг (так отдают Remnawave, Marzban, Happ): узел — каждый выход vless,
  vmess, trojan или shadowsocks (у vless — и плоская форма настроек Xray 25+ без
  `vnext`), имя — `remarks`; `freedom`, `blackhole` и `dns`
  молча пропускаются. Clash YAML, sing-box JSON и SIP008 не поддерживаются.
- Своя маршрутизация подписки (`routing.ts`): из JSON-конфигов — правила в выходы
  `freedom` («мимо туннеля») и `blackhole` («блокируется»), из заголовка ответа
  `routing` (вид Happ: `happ://routing/add/<base64>`, списки `DirectSites`,
  `DirectIp`, `BlockSites`, `BlockIp`). `routingOfConfigs`, `parseRoutingHeader` и
  `mergeRouting` отдают сводку: сколько записей, откуда известно и до 8 имён
  `geosite:`/`geoip:`; повторы между источниками считаются один раз, нечитаемый
  заголовок — «есть, состав не разобран». Только для сведения: пул её не применяет.
- Загрузка подписки шлёт `User-Agent` и `x-device-os: Linux` (`DEVICE_OS`); необязательный `hwid`
  уходит заголовком `x-hwid` для подписок с ограничением числа устройств, но
  только на исходный origin: на переход к другому хосту или порту — без него.
- Ссылки: `vless://`, `vmess://` (JSON и адресная форма), `trojan://`, `ss://`.
  Транспорты `tcp`, `ws`, `grpc`, `httpupgrade`, `xhttp`; безопасность `none`,
  `tls`, `reality`. Что не умеем — пропускается с причиной, а не угадывается.
- Способы подключения поставщиков (Р192, `tasks/T-0387`): `extra` у XHTTP
  (`transport.extra`: параметр `extra` ссылки либо объект `extra` и прочие поля
  `xhttpSettings` JSON), ECH (`ech`, `echConfigList`, `echForceQuery`), закреплённый
  сертификат и проверка по имени (`pcs`, `vcn`; старые поля закрепления Xray 26.11 ещё
  принимает — `security.legacyPinning`, три поля и только списки строк), постквантовая
  проверка REALITY (`pqv`, `mldsa65Verify`), `flow` `xtls-rprx-vision-udp443`, шифрование
  VLESS (`encryption` → `cipher`), HTTP-маскировка RAW (`headerType=http` →
  `transport.rawHeader`) и цепочка узла через `freedom` того же конфига (`dialer.settings`:
  фрагментация, шум; в конфиге — служебный выход `<тег узла>-dial`, `sockopt.dialerProxy`).
  Строки новых параметров — видимые знаки ASCII, 1–4096; отпечаток — 64 hex; объекты —
  не длиннее 4096 знаков и не глубже 8 уровней (`jsonObjectOf`), иначе `malformed` с именем
  параметра: значение, которого Xray не примет, обрушило бы конфиг всех подписок. Ключ
  узла дополняется новыми частями только когда они заданы: у прежних узлов он прежний.
  По-прежнему пропуск с причиной: `allowInsecure`, kcp, `flow` `direct`/`origin`/`splice`,
  цепочка на другой прокси-выход (`dialerProxy`) и `freedom` с `redirect`
  (`dialerProxy.redirect`), несколько `vnext`/`servers`/`users`, VMess `alterId` ≠ 0,
  плагин Shadowsocks.
- Секреты ссылок не попадают в причины пропуска и в тексты ошибок.
- Конфиг Xray: локальный SOCKS-вход на узел, стабильные слоты между обновлениями.
  Узлы нескольких подписок идут одним конфигом: у каждого узла есть группа (ключ
  подписки), тег выхода — `out-<группа>-<ключ узла>`, а слоты подписки не
  пересекаются со слотами других и не превышают её долю. С параметром `stats: { port }`
  в конфиг входят счётчики трафика выходов (`stats`, `policy.system`) и служба `api`
  только с `StatsService` на `<listen>:<port>`; порт не может лежать среди SOCKS-входов.
  Без `stats` конфиг прежний.
- Статистика Xray (`xray-stats.ts`): тело gRPC `StatsService/QueryStats` без
  protobuf-библиотеки — запрос (`encodeQueryStatsRequest`), ответ
  (`decodeQueryStatsResponse`, значения `bigint`), рамки gRPC (`grpcFrame`,
  `grpcUnframe`), путь метода (`STATS_SERVICE_PATH`) и разбор имён счётчиков выходов
  `outbound>>>out-<подписка>-<узел>>>>traffic>>>(uplink|downlink)` в трафик узла
  (`trafficOfStats`). Сети нет: соединение и таймаут — дело вызывающего. Ответ не по
  формату — `XrayStatsFormatError`.
- Схема узла (`proxyNodeSchema`, Zod) — для чтения узлов с диска: пакет сам файлы
  не пишет, но схема держит границу, если их пишет вызывающий.
- Пул: проверка здоровья с ростом паузы для «лежащих» узлов, выбор по задержке и
  стране; своё условие выбора — `accept`.

## Пример

```ts
import { assignSlots, buildXrayConfig, fetchSubscription, NodePool, parseSubscription, type PlacedNode } from "@bh/proxy-kit";

const { body } = await fetchSubscription(url, {
  fetch,
  assertAllowed: async (target) => { /* резолв имени и isPublicAddress для каждого адреса */ },
});
const { nodes, skipped } = parseSubscription(body);

// Слоты подписки "main": чужие слоты (reserved) не брать, больше доли (limit) не занимать.
const { slots } = assignSlots(nodes.map((node) => node.key), new Map(), { slotCount: 32, reserved: new Set(), limit: 16 });
const placed: PlacedNode[] = nodes.flatMap((node) => (slots.has(node.key) ? [{ group: "main", node, slot: slots.get(node.key) ?? 0 }] : []));
// Узлы других подписок добавляются в тот же список со своим group. Тег выхода: out-main-<ключ узла>.
const config = buildXrayConfig(placed, { basePort: 10800, slotCount: 32, listen: "127.0.0.1" });

const pool = new NodePool();
pool.sync(nodes, Date.now());
for (const key of pool.due(Date.now())) { /* проверить узел и вызвать pool.record(key, …, Date.now()) */ }
const best = pool.pick({ countries: ["DE"], limit: 3 });
// своё условие поверх страны: например, только узлы включённых подписок
const enabled = pool.pick({ limit: 3, accept: (entry) => entry.key.startsWith("main:") });
```

## Проверки

`pnpm --filter @bh/proxy-kit typecheck`, тесты — `vitest run packages/proxy-kit`.
Расхождения с образом Xray (`xray run -test`) правятся в таблице `F` в начале
`src/xray-config.ts`.
