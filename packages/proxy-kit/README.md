# @bh/proxy-kit

Исходящие запросы сервера через узлы подписки Xray: разбор подписки и ссылок
узлов, защита адреса подписки от SSRF, загрузка подписки, конфиг контейнера-спутника
и пул узлов с проверкой здоровья. Пакет самостоятельный: ничего из монорепо,
Nest и Prisma; сеть, время и DNS приходят аргументами.

## Что умеет

- Подписка: base64 (обычный или URL-safe, с `=` или без) либо открытый текст со
  списком ссылок. Clash YAML, sing-box JSON и SIP008 не поддерживаются.
- Ссылки: `vless://`, `vmess://` (JSON и адресная форма), `trojan://`, `ss://`.
  Транспорты `tcp`, `ws`, `grpc`, `httpupgrade`, `xhttp`; безопасность `none`,
  `tls`, `reality`. Что не умеем — пропускается с причиной, а не угадывается.
- Секреты ссылок не попадают в причины пропуска и в тексты ошибок.
- Конфиг Xray: локальный SOCKS-вход на узел, стабильные слоты между обновлениями.
- Пул: проверка здоровья с ростом паузы для «лежащих» узлов, выбор по задержке и стране.

## Пример

```ts
import { assignSlots, buildXrayConfig, fetchSubscription, NodePool, parseSubscription } from "@bh/proxy-kit";

const { body } = await fetchSubscription(url, {
  fetch,
  assertAllowed: async (target) => { /* резолв имени и isPublicAddress для каждого адреса */ },
});
const { nodes, skipped } = parseSubscription(body);

const { slots } = assignSlots(nodes.map((node) => node.key), new Map(), 32);
const config = buildXrayConfig(nodes, slots, { basePort: 10800, slotCount: 32, listen: "127.0.0.1" });

const pool = new NodePool();
pool.sync(nodes, Date.now());
for (const key of pool.due(Date.now())) { /* проверить узел и вызвать pool.record(key, …, Date.now()) */ }
const best = pool.pick({ countries: ["DE"], limit: 3 });
```

## Проверки

`pnpm --filter @bh/proxy-kit typecheck`, тесты — `vitest run packages/proxy-kit`.
Расхождения с образом Xray (`xray run -test`) правятся в таблице `F` в начале
`src/xray-config.ts`.
