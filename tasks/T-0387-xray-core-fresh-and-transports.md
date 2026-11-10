---
id: T-0387
title: Ядро Xray — свежая версия и способы подключения, которые выдают поставщики
epic: E13
priority: P2
status: ready
owner:
author: claude-lead2-4
size: M
depends_on: [T-0384, T-0385, T-0386]
zones:
  - packages/proxy-kit/src/node.ts
  - packages/proxy-kit/src/node-schema.ts
  - packages/proxy-kit/src/links/**
  - packages/proxy-kit/src/xray-json/**
  - packages/proxy-kit/src/xray-config.ts
  - packages/proxy-kit/src/internal/json.ts
  - packages/proxy-kit/test/share-link.test.ts
  - packages/proxy-kit/test/xray-json.test.ts
  - packages/proxy-kit/test/xray-config.test.ts
  - packages/proxy-kit/test/node-schema.test.ts
  - packages/proxy-kit/test/node-key.test.ts
  - packages/proxy-kit/test/fixtures/**
  - backend/api/src/modules/proxies/subscription/subscription.messages.ts
  - backend/api/test/proxy-subscription.test.ts
  - infra/prod/xray/Dockerfile
  - infra/prod/xray/check-config.sh
shared:
  - packages/proxy-kit/README.md
  - docs/20-env-and-ports.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 5
---

# T-0387. Ядро Xray — свежая версия и способы подключения, которые выдают поставщики

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0387.json)](README.md#значки-статуса) [![T-0384](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0384.json&label=T-0384)](T-0384-xray-multi-subscription.md) [![T-0385](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0385.json&label=T-0385)](T-0385-xray-node-transport-security.md) [![T-0386](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0386.json&label=T-0386)](T-0386-xray-traffic-stats.md)

## Зачем

Поставщики подписок выдают узлы с параметрами, которые наш разбор сейчас
пропускает: `extra` у XHTTP, ECH, закреплённые сертификаты, постквантовую проверку
REALITY, шифрование VLESS, цепочку через `freedom` с фрагментацией. Такие узлы
отсеиваются, а часть подписки остаётся без дела. Р192 требует держать ядро Xray
актуальным, а такие способы подключения разбирать, а не пропускать. После задачи
узлы с этими параметрами работают. Что по-прежнему пропускается, пропускается с
понятной причиной, и в итоге обновления видно, какой именно параметр отсеял узел.

## Решения

- **Р192** (`docs/35-stage4-plan.md`): ядро Xray актуальное; способы подключения от
  поставщиков разбираются, а не пропускаются.
- **Р101, T-0093**: образ с точной версией и digest; золотые конфиги прогоняются
  `check-config.sh`; что Xray не принял, правится в таблице `F` (`xray-config.ts`) и в
  золотых файлах. Причина пропуска не содержит кусков ссылки (`detail` — имя
  параметра).

**Версия ядра на 07.11.2026** (`claude-lead2-4`). В `infra/prod/xray/Dockerfile:6` —
`ghcr.io/xtls/xray-core:26.10.31@sha256:ceabeac03a89d991d2a247361825c1d1d2e9c91cd5dc010f298c7dc0c2f325c9`.
Реестр `ghcr.io` проверен из среды тимлида: самая новая метка с номером — `26.10.31`;
метки `latest` и `pre-release` указывают на тот же digest. Страница выпусков GitHub
из той среды недоступна. Поэтому не проверено, помечен ли `26.10.31` как pre-release
и не вышло ли что-то новее. Это шаг 2 исполнителя.

**Что поддерживаем и что оставляем пропуском** (`claude-lead2-4`, в рамках Р192):

| Что | Где приходит | Решение |
|---|---|---|
| `extra` у XHTTP | ссылка `extra=<JSON>`; JSON — `xhttpSettings.extra` и прочие поля `xhttpSettings`, кроме `path`, `host`, `mode` | **поддержать**: объект передаётся в `xhttpSettings.extra` как есть |
| ECH | ссылка `ech`; JSON `tlsSettings.echConfigList`, `echForceQuery` | **поддержать** |
| Закреплённый сертификат, проверка по имени | ссылка `pcs`, `vcn`; JSON `pinnedPeerCertSha256`, `verifyPeerCertByName` | **поддержать**: это строже обычной проверки, а не слабее |
| Старые поля закрепления (`pinnedPeerCertificateChainSha256`, `pinnedPeerCertificatePublicKeySha256`, `verifyPeerCertInNames`) | JSON | решает образ: принимает `xray run -test` — передаём как есть; не принимает — пропуск с `detail` по имени поля |
| Постквантовая проверка REALITY | ссылка `pqv`; JSON `realitySettings.mldsa65Verify` | **поддержать** |
| `flow` `xtls-rprx-vision-udp443` | ссылка и JSON | **поддержать** вместе с `xtls-rprx-vision` |
| Прочие `flow` (`xtls-rprx-direct`, `-origin`, `-splice`) | ссылка и JSON | **пропуск**: режимы убраны из Xray, ядро их не примет |
| Шифрование VLESS (`encryption` ≠ `none`) | ссылка `encryption`; JSON `users[].encryption` | **поддержать**: строка передаётся как есть |
| HTTP-маскировка RAW (`headerType=http`) | ссылка `headerType`, `host`, `path`; JSON `tcpSettings.header` / `rawSettings.header` | **поддержать** |
| Цепочка `dialerProxy` / `proxySettings` на выход `freedom` того же конфига (фрагментация, шумы) | JSON | **поддержать**: служебный выход `freedom` собирается рядом с узлом |
| Цепочка на другой прокси-выход | JSON | **пропуск** `dialerProxy` — вопрос 2 |
| `freedom` с `redirect` в цепочке | JSON | **пропуск** `dialerProxy.redirect`: перенаправил бы трафик узла на другой адрес |
| `allowInsecure` | ссылка, JSON | **пропуск**, как сейчас: отключает проверку сертификата узла — вопрос 1 |
| kcp | ссылка, JSON | **пропуск**: у поставщиков подписок не встречается, добавим по живому образцу |
| Несколько `vnext`, `servers`, `users` в одном выходе | JSON | **пропуск**: это балансировка внутри выхода, а у нас узел — один адрес |
| VMess `alterId` ≠ 0 | ссылка, JSON | **пропуск**: старая аутентификация VMess, в Xray её нет |
| Плагин Shadowsocks (`plugin=`) | ссылка | **пропуск**: Xray не запускает внешние плагины |

Общие правила для новых полей:
- **Строки** (`ech`, `pcs`, `vcn`, `pqv`, шифрование VLESS) — видимые знаки ASCII,
  `^[!-~]{1,4096}$`. Иначе пропуск `malformed` с `detail` по имени параметра.
- **Объекты** (`extra`, заголовок RAW, настройки `freedom`) — JSON-объект, в
  сериализованном виде не длиннее 4096 знаков, вложенность не глубже 8. Иначе
  `malformed`.
- **Ключ узла.** Новое поле дописывается к строке ключа узла (`finishNode`,
  `links/common.ts`) **только если оно задано**, объект — в каноническом JSON (ключи по
  порядку). У узлов без новых полей ключ прежний: их слот и здоровье переживают
  выкатку.

## Как сейчас

- `packages/proxy-kit/src/links/common.ts`: `UNSUPPORTED_FLAGS` (`allowInsecure`,
  `insecure`), `UNSUPPORTED_VALUES` (`pcs`, `vcn`, `ech`, `pqv`) → `unsupported_option`;
  `headerType` у tcp ≠ `none` → пропуск; параметр `extra` молча игнорируется;
  `finishNode` — ключ из протокола, хоста, порта, секрета, `canonicalTransport`,
  `canonicalSecurity`.
- `links/vless.ts`: `encryption` ≠ `none` и `flow` ≠ `xtls-rprx-vision` → пропуск.
  `links/vmess.ts`: `aid` ≠ 0, `type` у tcp → пропуск. `links/shadowsocks.ts`: `plugin` → пропуск.
- `xray-json/stream.ts`: `sockopt.dialerProxy` → пропуск; `allowInsecure`, `pinned*`,
  `verifyPeerCert*`, `echConfigList`, `mldsa65Verify` → пропуск; `tcpSettings.header.type`
  ≠ `none` → пропуск. Схема `pathSection` молча **отбрасывает** прочие поля
  `xhttpSettings` (`xPaddingBytes`, `xmux`, `downloadSettings`…): узел собирается без
  них и может не работать.
- `xray-json/outbound.ts`: `proxySettings` → пропуск; `encryption`, `flow` — как у
  ссылки; несколько `vnext`/`users`/`servers` → пропуск. `xray-json/document.ts` —
  `parseOutbound(scheme, outbound, remarks)` не видит соседних выходов конфига.
- `xray-config.ts` (после T-0384 и T-0386): `buildXrayConfig(placed, options)`, таблица
  `F`, тег `outboundTag(group, key)`.
- `node-schema.ts` (T-0384) — Zod-схема `ProxyNode`, ей читаются части конфига на диске.
- `backend/.../subscription.messages.ts`: `successNote` и `noNodesNote` — числа по
  причинам («параметры: 3»), без имён параметров.
- `infra/prod/xray/Dockerfile:6` — версия и digest; `check-config.sh` прогоняет
  `packages/proxy-kit/test/fixtures/xray/*.json` через `xray run -test`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Версия ядра.** Открыть `https://github.com/XTLS/Xray-core/releases` и взять
   последний выпуск **без** пометки Pre-release.
   - Он новее `26.10.31` — `docker buildx imagetools inspect ghcr.io/xtls/xray-core:<тег>`
     и digest списка образов в `Dockerfile:6`. Проверить пути, которые копирует
     `Dockerfile`: `docker run --rm --entrypoint sh <образ> -c 'ls /usr/local/bin/xray /usr/local/share/xray /etc/ssl/certs/ca-certificates.crt'`.
     Официальный образ без оболочки — тогда `docker create` и `docker cp` тех же путей.
     Нет пути — стоп, вопрос тимлиду.
   - Это `26.10.31` — образ не меняется, в PR строка «версия актуальна на <дата>».
   - Последний стабильный **старше** `26.10.31` (сам `26.10.31` помечен pre-release) —
     стоп, вопрос тимлиду: молча откатывать версию нельзя.
   - В PR — вывод `xray version` из собранного образа.
3. **Типы** (`node.ts`), все поля необязательные:
   - `NodeTransport`: `extra?: Record<string, unknown>` (только `xhttp`),
     `rawHeader?: Record<string, unknown>` (только `tcp`, объект `header` Xray);
   - `tls`: `ech?: string`, `echForceQuery?: "none" | "half" | "full"`,
     `pinnedPeerCertSha256?: string`, `verifyPeerCertByName?: string`, плюс
     `legacyPinning?: Record<string, unknown>` для старых полей, если образ их принял
     (шаг 9);
   - `reality`: `mldsa65Verify?: string`;
   - `ProxyNode`: `dialer?: { settings: Record<string, unknown> }` — настройки
     служебного `freedom`. Шифрование VLESS — в существующем `cipher` (у vless сейчас
     `null`); комментарий поля дополнить.
   - `node-schema.ts` — те же поля. Тест схемы ловит расхождение.
4. **Помощник** `internal/json.ts`: `jsonObjectOf(value, { maxChars: 4096, maxDepth: 8 })` →
   объект или `null`; `canonicalJson(value)` — ключи по порядку на всех уровнях.
5. **Ссылки** (`links/common.ts`, `vless.ts`, `vmess.ts`):
   - из `UNSUPPORTED_VALUES` убрать `pcs`, `vcn`, `ech`, `pqv` — они разбираются в
     `securityFromParams`: `tls` + `ech`, `pcs`, `vcn`; `reality` + `pqv`.
     `allowInsecure`/`insecure` остаются в `UNSUPPORTED_FLAGS`;
   - `extra` у `xhttp` — `JSON.parse` и `jsonObjectOf`; не объект — `malformed` `extra`.
     У другого транспорта `extra` игнорируется, как сейчас;
   - `headerType=http` у tcp — `rawHeader = { type: "http", request: { path: [...], headers: { Host: [...] } } }`.
     `path` и `host` — списки через запятую. Без `path` — `["/"]`, без `host` —
     заголовка `Host` нет. Другое значение ≠ `none` — пропуск `headerType`, как сейчас;
   - vless: `flow` из `["xtls-rprx-vision", "xtls-rprx-vision-udp443"]`, иначе пропуск
     `flow`; `encryption` ≠ `none` — в `cipher` по правилу строк;
   - vmess (JSON-форма): `type=http` у tcp — так же, как `headerType=http`.
6. **JSON Xray** (`xray-json/stream.ts`, `outbound.ts`, `document.ts`):
   - `stream.ts`: `pathSection` — схема с `.passthrough()` для `xhttpSettings`. Поля,
     кроме `path`, `host`, `mode`, и объект `extra` (он важнее) идут в `transport.extra`
     через `jsonObjectOf`. В `extra.downloadSettings` с непустым `sockopt.dialerProxy` —
     пропуск `extra.downloadSettings`. `tlsSettings`: `echConfigList`, `echForceQuery`,
     `pinnedPeerCertSha256`, `verifyPeerCertByName` — по правилу строк; старые поля —
     по шагу 9. `realitySettings.mldsa65Verify` — по правилу строк.
     `tcpSettings`/`rawSettings`: `header.type = "http"` — `rawHeader` через `jsonObjectOf`
     всего `header`;
   - `document.ts`: для каждого конфига — карта «тег → выход» его `outbounds`, она
     передаётся в `parseOutbound(scheme, outbound, remarks, siblings)`;
   - `outbound.ts` и `stream.ts`: `sockopt.dialerProxy` (или `proxySettings.tag`) указывает
     на соседний выход с протоколом `freedom` — `node.dialer = { settings }` из его
     `settings` (`jsonObjectOf`; нет `settings` — `{}`). В `settings.redirect` что-то
     есть — пропуск `dialerProxy.redirect`. Соседа нет или он не `freedom` — пропуск
     `dialerProxy`, как сейчас. Прочие поля `sockopt` по-прежнему не переносятся;
   - `encryption`, `flow` у vless — как в шаге 5.
7. **Ключ узла** (`links/common.ts`, `finishNode`): к строке ключа дописываются только
   заданные части в постоянном порядке: `x=<canonicalJson(extra)>`,
   `h=<canonicalJson(rawHeader)>`, `ech=…`, `efq=…`, `pcs=…`, `vcn=…`, `lp=<canonicalJson(legacyPinning)>`,
   `pqv=…`, `enc=<cipher у vless>`, `d=<canonicalJson(dialer.settings)>`. Тест на
   прежние ключи (шаг «Тесты») — до правки.
8. **Конфиг** (`xray-config.ts`): `xhttpSettings.extra`; `tcpSettings.header` (или
   `rawSettings` — какое имя примет образ, решает `xray run -test`, имя — в таблицу
   `F`); поля TLS и REALITY под теми же именами; `users[0].encryption = node.cipher ?? "none"`
   у vless. Узел с `dialer` — второй выход
   `{ tag: \`${outboundTag(group, key)}-dial\`, protocol: "freedom", settings }`
   сразу после выхода узла и `sockopt: { dialerProxy: "<тот же тег>" }` в
   `streamSettings` узла. Суффикс `-dial` T-0386 не считает узлом: байты не
   задвоятся. Входов служебный выход не получает.
9. **Золотые конфиги и образ** (поэтому `runner: local`). Новые файлы в
   `test/fixtures/xray/`: `vless-xhttp-extra-reality.json`, `vless-tls-ech.json`,
   `vless-tls-pinned.json`, `vless-reality-pqv.json`, `vless-encryption.json`,
   `vmess-raw-http-header.json`, `vless-dialer-fragment.json`, `vless-vision-udp443.json`.
   Выдуманные значения, где ядро проверяет форму (ключ REALITY, ECH, mldsa65,
   шифрование VLESS), — заглушки по образцу `PUBLICKEYn`, подстановка в `check-config.sh`
   правильной формы: сгенерировать один раз `xray x25519`, `xray mldsa65`,
   `xray vlessenc` в образе и вписать **выдуманные, не боевые** значения в `sed`
   скрипта. Старые поля закрепления: золотой файл с каждым из трёх полей. Принял —
   поддерживаются (`legacyPinning`, как есть); не принял — пропуск с `detail` `pcs`
   или `vcn`, файл удаляется, в PR — вывод ошибки ядра. `bash infra/prod/xray/check-config.sh` —
   все `ok`, вывод — в PR.
10. **Итог обновления** (`subscription.messages.ts`): после числа по причине — имена
    параметров, до трёх самых частых: «37 узлов, пропущено 4 — параметры: allowInsecure 2,
    dialerProxy 1; транспорт: kcp 1». `noNodesNote` — так же. Предел заметки — 300 знаков,
    как сейчас (`clip`). `detail` и раньше был именем параметра, не куском ссылки, —
    это не меняется.
11. **Документы** — раздел «Документы».

## Чего не трогаем

- Новые протоколы (`hysteria2://`, `wireguard://`, `tuic://`, `socks://`, `http://`) —
  вопрос 3; сейчас `unsupported_scheme`, как было.
- Прочие поля `sockopt` (`mark`, `interface`, `tcpFastOpen`…): требуют прав контейнера
  или не нужны узлу.
- `run.sh`, `compose.yml`, права контейнера.
- Перебор, части конфига, учёт трафика, маршрутизацию подписки — T-0384–T-0386.

## Сценарий и интерфейс

Экранов не прибавляется. В карточке подписки итог обновления называет параметры
пропуска (шаг 10). Узлы, которые раньше отсеивались, появляются в таблице после
ближайшего обновления подписки.

## Тесты

Первым коммитом.

- **`packages/proxy-kit/test/node-key.test.ts`** — до правки ключа: ключи узлов из
  `test/fixtures/links.ts` и `remnawave-array.json` записаны числами и после задачи
  не меняются.
- **`packages/proxy-kit/test/share-link.test.ts`:**
  - `vless://…?type=xhttp&security=reality&…&extra=<urlencoded {"xPaddingBytes":"100-1000","xmux":{"maxConcurrency":"16-32"}}>`
    → `transport.extra` равен объекту; `extra=not-json`, `extra=[1]`, `extra` на 5000
    знаков → `malformed` / `extra`;
  - `security=tls&ech=<строка>&pcs=<hex>&vcn=example.com` → поля в `security`;
    `ech` с пробелом → `malformed` / `ech`;
  - `security=reality&pqv=<строка>` → `mldsa65Verify`;
  - `flow=xtls-rprx-vision-udp443` → узел; `flow=xtls-rprx-direct` → `unsupported_option` / `flow`;
  - `encryption=mlkem768x25519plus.native.0rtt.<…>` → `cipher`; `encryption=none` → `cipher: null`;
  - `type=tcp&headerType=http&host=a.com,b.com&path=/x` → `rawHeader` по шагу 5;
    `headerType=srtp` → пропуск `headerType`;
  - `allowInsecure=1` → `unsupported_option` / `allowInsecure`, как было;
  - в причинах нет `ech`, `pcs`, ключа, UUID — только имена параметров.
- **`packages/proxy-kit/test/xray-json.test.ts`:**
  - `xhttpSettings` с `xPaddingBytes` и `extra.xmux` → оба в `transport.extra`, `extra`
    важнее при совпадении ключа; `extra.downloadSettings.sockopt.dialerProxy` → пропуск
    `extra.downloadSettings`;
  - выход с `sockopt.dialerProxy: "fragment"` и соседом
    `{ tag: "fragment", protocol: "freedom", settings: { fragment: { packets: "tlshello", length: "100-200", interval: "10-20" } } }`
    → узел с `dialer.settings` равным этим настройкам; сосед с `redirect` → пропуск
    `dialerProxy.redirect`; сосед `vless` или тега нет → пропуск `dialerProxy`;
    `proxySettings: { tag: "fragment" }` — как `dialerProxy`;
  - `tlsSettings.echConfigList`, `pinnedPeerCertSha256`, `verifyPeerCertByName`,
    `realitySettings.mldsa65Verify` → поля узла;
  - `tcpSettings.header: { type: "http", request: {...} }` → `rawHeader`;
  - служебный выход `freedom`, на который ссылается узел, сам узлом и пропуском не становится.
- **`packages/proxy-kit/test/xray-config.test.ts`** — узел с `dialer` → два выхода (узел
  и `<тег>-dial`), `sockopt.dialerProxy`, вход один; `extra`, `rawHeader`, ECH, `pqv`,
  шифрование VLESS — на своих местах; все новые золотые файлы совпадают.
- **`packages/proxy-kit/test/node-schema.test.ts`** — узлы с каждым новым полем проходят
  схему; `extra: "строка"` — отказ.
- **`backend/api/test/proxy-subscription.test.ts`** — заметки шага 10: имена параметров,
  не больше трёх на причину, предел 300 знаков; в заметке нет значений параметров.
- **Вручную, в PR:** `xray version`, вывод `check-config.sh` (все `ok`), итог шага 2.

## Аналитика

Нет: разбор подписки для панели, игрок его не видит.

## Настройки и окружение

Нет. Версия образа — `infra/prod/xray/Dockerfile`.

## Документы

- **`docs/29-admin-panel.md`**, строка «Прокси»: «Что не умеем (другие протоколы,
  цепочки через `dialerProxy`, `allowInsecure`, ECH, транспорт kcp и т. п.)» → перечень
  из таблицы «Решения»: что теперь разбирается и что по-прежнему пропускается с
  причиной; итог обновления называет параметры.
- **`docs/30-configuration-map.md`**, строка «Контейнер Xray» — версия ядра на дату; строка
  разбора — пределы строк и объектов (4096 знаков, вложенность 8).
- **`docs/20-env-and-ports.md`**, раздел про спутник — «Смена версии Xray»: шаг 2 этой задачи.
- **`packages/proxy-kit/README.md`**, «Что умеет» — новые параметры и что пропускается.

## Критерии приёмки

- [ ] Узлы с `extra` XHTTP, ECH, `pcs`/`vcn`, `pqv`, `xtls-rprx-vision-udp443`,
      шифрованием VLESS, `headerType=http` и цепочкой на `freedom` разбираются и
      собираются в конфиг, который принимает `xray run -test`.
- [ ] Остальное из таблицы пропускается с причиной; итог обновления называет параметр.
- [ ] Ключи прежних узлов не изменились.
- [ ] Версия ядра сверена с выпусками GitHub на день работы; образ с версией и digest.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` зелёные; `check-config.sh` — все `ok`.

## PR

- **Заголовок:** `feat(proxy-kit): Способы подключения Xray от поставщиков подписок`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СПОСОБЫ ПОДКЛЮЧЕНИЯ XRAY ОТ ПОСТАВЩИКОВ**

  Разбор подписок Xray понимает больше способов подключения: XHTTP с дополнительными настройками, ECH, закреплённые сертификаты, постквантовую проверку REALITY, шифрование VLESS, HTTP-маскировку и фрагментацию через freedom. Такие узлы больше не отсеиваются. Что по-прежнему не поддерживается, итог обновления называет по имени параметра.

  🛠 **Эксплуатация**

  • версия ядра Xray сверена с выпусками на день работы (версия — в описании PR)
  • новые узлы появятся после ближайшего обновления каждой подписки
  ```

## Вопросы к тимлиду

Неблокирующие: спецификация написана по варианту «(Рекомендуется)».

1. **`allowInsecure`.** Узел с ним не проверяет сертификат сервера. Запросы API к
   внешним сервисам внутри всё равно идут по TLS, но сам туннель можно подменить.
   (а) Оставить пропуском с причиной (Рекомендуется); (б) поддержать и показывать у
   узла пометку «без проверки сертификата».
2. **Цепочка `dialerProxy` на другой прокси-выход** (двойной узел). (а) Пропуск с
   причиной (Рекомендуется): узел — один адрес в переборе и в учёте трафика; (б)
   поддержать один шаг цепочки отдельной задачей.
3. **Новые протоколы** (`hysteria2`, WireGuard и др.). Р192 говорит о способах
   подключения, которые выдают поставщики. Протоколы сверх VLESS, VMess, Trojan и
   Shadowsocks — новое поведение `proxy-kit`. (а) Отдельной задачей после этой, по
   живой подписке с такими узлами и списку протоколов, которые принимает ядро
   выбранной версии (Рекомендуется); (б) не делать.
