---
id: T-0040
title: Снимок перед вайпом — что вернуть тестеру и какой бонус дать
epic: E2
priority: P1
status: ready
owner:
size: M
depends_on: [T-0039]
zones:
  - backend/api/src/modules/wipe/tester-snapshot.ts
  - backend/api/src/modules/wipe/compensation-rules.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/tester-snapshot.integration.test.ts
  - backend/api/test/compensation-rules.test.ts
  - backend/api/test/wipe-plan.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: none
design: null
---

# T-0040. Снимок перед вайпом — что вернуть тестеру и какой бонус дать

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0040.json)](README.md#значки-статуса) [![T-0039](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0039.json&label=T-0039)](T-0039-wipe-plan.md)

## Зачем

Вайп сотрёт кошелёк и уровень (Р87). Тестеру мы обещали вернуть купленное за
звёзды и дать бонус, а после вайпа считать их будет не из чего. Задача
добавляет таблицу компенсаций, знак «Тестер» у аккаунта и функцию снимка.
Снимок записывает всё это в той же транзакции, что вайп (T-0041). Выдачу
делает T-0042.

## Решения

Р87, решение пользователя от 07.10.2026:

- **Купленное возвращается в том количестве, что начислила покупка.**
  Источник — строки журнала кошелька с ключом `purchase:<purchaseId>:<ресурс>`.
  Каталог магазина не годится: состав набора мог поменяться после покупки.
- **Бонус и знак — тестеру**, то есть аккаунту, у которого до вайпа был хотя
  бы один завершённый забег.
- **Бонус — 5 самоцветов за уровень аккаунта, не больше 250.**
- **Знак «Тестер» — навсегда.** Ставится снимком, а не при выдаче: знак виден,
  даже если игрок окно «Спасибо за тест» ещё не открыл.
- **Второй шанс, купленный за звёзды, компенсируется самоцветами.** Решение
  пользователя от 07.10.2026, дополнение к Р87. Курс — открытый вопрос О43.
  Поэтому снимок хранит **списанные звёзды**, а не самоцветы: курс применяет
  выдача (T-0042), и решение О43 до вайпа не потребует переделывать снимок.

Решения тимлидов:

- **Что возвращаем:** только живые оплаты (`mode = live`), за которые звёзды
  не возвращались и возврат не заказан. Тестовые оплаты бывают только в
  разработке, а за возвращённые деньги возвращать нечего.
- **Забеги с читами (`cheats = true`) тестером не делают**: читы доступны
  только в инструментах команды.
- **Строка компенсации — только у того, кому есть что выдать:** тестер или
  есть что вернуть из купленного. Остальным строка не нужна.
- **Снимок делается один раз.** Если строки уже есть, снимок отказывается:
  второй вайп — новое решение, а не повтор команды.
- **Самоцветы VIP за день** (`subscription_daily`) не возвращаются. Это
  награда за дни подписки, а не покупка, и сама подписка остаётся (Р87).

## Как сейчас

- **Журнал кошелька — модель `WalletEntry`:**
  - `idempotencyKey` (уникальный), `reason`, `resource`, `amount` (`BigInt`);
  - выдача товара магазина пишет строки `reason = "purchase"`, ключ
    `purchase:<purchaseId>:<resource>` (`shop/shop.service.ts`, `fulfill`).
- **Покупки — модель `Purchase`:** `mode`, `paidAt`, `refundRequestedAt`,
  `refundedAt`, `product`, `chargedStars`. У второго шанса
  `product = "continue_run"`, начислений в кошельке нет: продолжение
  засчитывается в забеге.
- **Уровень — модель `AccountProgress`:** `level`, умолчание 1; строки может
  не быть, тогда уровень 1.
- **Забеги — модель `Run`:** `status` (`started` | `finished`), `cheats`.
- **План вайпа — `modules/wipe/wipe-plan.ts` (T-0039).** Тест требует строку на
  каждую модель.
- Образец интеграционного теста на живом Postgres —
  `test/payments.integration.test.ts`:
  - `describe.skipIf(DATABASE_URL === "")`;
  - аккаунты через `accounts.upsert`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция.**
   - В `Account`:

     ```prisma
     /// знак «Тестер» (docs/35-stage4-plan.md Р87): играл до вайпа; ставится снимком, навсегда
     testerAt DateTime? @map("tester_at") @db.Timestamptz(3)
     ```
   - Новая модель:

     ```prisma
     /// Компенсация после вайпа (docs/35-stage4-plan.md Р87): что вернуть из купленного
     /// и какой бонус дать. Пишется снимком в транзакции вайпа, выдаётся окном
     /// «Спасибо за тест» один раз (`claimedAt`).
     model TesterCompensation {
       accountId  String    @id @map("account_id") @db.Uuid
       /// играл до вайпа: знак и бонус
       tester     Boolean
       /// уровень аккаунта в момент снимка
       level      Int
       bonusGems  Int       @map("bonus_gems")
       /// что начислили покупки: [{ purchaseId, resource, amount }]
       grants     Json
       /// звёзды, списанные за второй шанс: выдача переводит их в самоцветы по курсу О43
       continueStars Int    @map("continue_stars")
       snapshotAt DateTime  @map("snapshot_at") @db.Timestamptz(3)
       claimedAt  DateTime? @map("claimed_at") @db.Timestamptz(3)

       account Account @relation(fields: [accountId], references: [accountId], onDelete: Cascade)

       @@map("tester_compensation")
     }
     ```

     Обратное поле у `Account` — `compensation TesterCompensation?`.
   - Миграция — по правилу «Общие файлы» в `tasks/README.md`: `--create-only`
     на отдельной базе, один раз, после перебазирования. В ней только колонка
     `tester_at` и таблица `tester_compensation`.
3. **`wipe-plan.ts`** — строка `TesterCompensation: { action: "keep", why: "компенсации тестерам выдаются после вайпа" }`.
4. **Новый `modules/wipe/compensation-rules.ts`:**

   ```ts
   /** Бонус тестеру (Р87): 5 самоцветов за уровень аккаунта, не больше 250. */
   export const TESTER_BONUS = { gemsPerLevel: 5, maxGems: 250 } as const;

   export function bonusGems(level: number): number; // min(max(level, 1) * 5, 250), целое

   /** Что начислила покупка — одна строка журнала кошелька. */
   export interface CompensationGrant {
     purchaseId: string;
     resource: WalletResource;
     amount: number;
   }

   export const compensationGrantsSchema: z.ZodType<CompensationGrant[]>;

   /** Разобрать ключ выдачи покупки `purchase:<purchaseId>:<resource>`; чужой ключ — `null`. */
   export function grantOfKey(key: string, amount: number): CompensationGrant | null;
   ```

   `compensationGrantsSchema` — массив объектов: `purchaseId` (uuid),
   `resource` (`z.enum(WALLET_RESOURCES)`), `amount` (целое > 0). Им T-0042
   разбирает `grants` из базы.
5. **Новый `modules/wipe/tester-snapshot.ts`:**

   ```ts
   export interface SnapshotTotals {
     accounts: number;
     testers: number;
     bonusGems: number;
     /** сколько вернётся из купленного, по ресурсам */
     restored: Partial<Record<WalletResource, number>>;
     /** звёзды за второй шанс — к переводу в самоцветы при выдаче */
     continueStars: number;
   }

   /**
    * Снимок компенсаций (Р87). `write: false` — только посчитать для `wipe --plan`;
    * `write: true` — записать строки и знак «Тестер». Повторный снимок с записью — ошибка.
    */
   export async function takeTesterSnapshot(tx: Prisma.TransactionClient, now: Date, options: { write: boolean }): Promise<SnapshotTotals>;
   ```

   По шагам:
   1. при `write: true` — если в `tester_compensation` есть хоть одна строка,
      бросить `Error("снимок компенсаций уже есть — вайп уже был")`;
   2. **тестеры** — `run.groupBy({ by: ["accountId"], where: { status: "finished", cheats: false } })`;
   3. **уровни** тестеров — `accountProgress.findMany`, нет строки → 1;
   4. **выдачи покупок**:
      - `walletEntry.findMany({ where: { reason: "purchase", idempotencyKey: { startsWith: "purchase:" }, amount: { gt: 0 } } })`;
      - каждую строку разобрать `grantOfKey`;
      - оставить только покупки, которые находит
        `purchase.findMany({ where: { purchaseId: { in }, mode: "live", refundedAt: null, refundRequestedAt: null } })`;
   5. **второй шанс** — `purchase.groupBy({ by: ["accountId"], where: { product: "continue_run", mode: "live", paidAt: { not: null }, refundedAt: null, refundRequestedAt: null }, _sum: { chargedStars: true } })`;
   6. **строки** — по аккаунтам, у которых `tester`, есть выдачи или
      `continueStars > 0`:
      - `bonusGems = tester ? bonusGems(level) : 0`;
      - `grants` — выдачи аккаунта, по `purchaseId`, затем по `resource`;
      - `continueStars` — сумма шага 5 или 0;
      - `level` — уровень или 1;
   7. при `write: true`:
      - `testerCompensation.createMany({ data })`;
      - `account.updateMany({ where: { accountId: { in: testers }, testerAt: null }, data: { testerAt: now } })`;
   8. вернуть итоги.

   Функция ничего не стирает и не открывает своих транзакций: её зовёт
   команда вайпа внутри своей (T-0041). Комментарий файла — почему снимок
   должен быть в той же транзакции: между снимком и стиранием никто не успеет
   ничего начислить.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Стирание и команду — T-0041.
- Выдачу компенсации и показ знака — T-0042, T-0043.
- Кошелёк: функция только читает его журнал.

## Тесты

Первым коммитом.

1. **`backend/api/test/compensation-rules.test.ts`:**
   - `bonusGems`: 0 и 1 → 5; 12 → 60; 50 → 250; 80 → 250;
   - `grantOfKey`:
     - `purchase:<uuid>:gems` → выдача;
     - `purchase:<uuid>:unknown`, `adjust:…` и `purchase:not-uuid:gems` → `null`;
   - `compensationGrantsSchema` отклоняет `amount: 0` и незнакомый ресурс.
2. **`backend/api/test/tester-snapshot.integration.test.ts`** — живой Postgres,
   `describe.skipIf(DATABASE_URL === "")`. Каждый кейс заводит своих
   аккаунтов и проверяет только их строки: база тестов общая.
   - тестер 12-го уровня с завершённым забегом и без покупок → строка
     `tester: true`, `bonusGems: 60`, `grants: []`, у аккаунта `testerAt = now`;
   - тестер 80-го уровня → `bonusGems: 250`;
   - забег только с `cheats: true` или только `started` → не тестер;
   - не тестер с живой выданной покупкой на 150 самоцветов → `tester: false`,
     `bonusGems: 0`, `grants: [{ purchaseId, resource: "gems", amount: 150 }]`,
     `testerAt` пуст;
   - покупка с `refundedAt`, с `refundRequestedAt` или `mode: "test"` — не в
     `grants`;
   - два вторых шанса за 3 и 7 ⭐ → `continueStars: 10`. Возвращённый второй
     шанс (`refundReason: "unused"`, `refundedAt`) не в счёт. Аккаунт, у
     которого есть только второй шанс, получает строку с `tester: false`,
     если сам не тестер;
   - аккаунт без забегов и покупок → строки нет;
   - `write: false` → строк нет, `testerAt` не тронут, итоги те же, что
     потом у `write: true`;
   - повторный `write: true` → ошибка «снимок компенсаций уже есть».

     Чтобы не мешать другим тестам общей базы, кейс проверяет отказ на
     транзакции, которая откатывается: `prisma.$transaction(async (tx) => { …; throw ROLLBACK })`.
     Так же устроены остальные кейсы с записью: снимок пишет внутри
     транзакции теста, проверки — внутри неё, в конце откат. Строки других
     тестов снимок может видеть: проверять итоги только по своим аккаунтам,
     через `tx.testerCompensation.findMany({ where: { accountId: { in: мои } } })`.
3. **`backend/api/test/wipe-plan.test.ts`** — зелёный: строка `TesterCompensation` есть.

## Аналитика

Нет: снимок — служебный шаг вайпа. Выдачу компенсации считает событие T-0042.

## Настройки и окружение

Нет. Бонус — константа `TESTER_BONUS` (Р87); строка в
`docs/30-configuration-map.md` появится в T-0042 вместе с выдачей.

## Документы

- `docs/21-diagrams.md`, ER:
  - таблица `TESTER_COMPENSATION` со связью к `ACCOUNT`;
  - у `ACCOUNT` — `tester_at`.
- `docs/35-stage4-plan.md`, WP33 — «Как сделано, часть 2 — снимок компенсаций»:
  - что считается, кому строка;
  - бонус;
  - знак ставится снимком;
  - снимок один раз и в транзакции вайпа.

## Критерии приёмки

- [ ] Снимок записывает компенсацию тем, кто играл или покупал. В ней
  уровень, бонус по Р87 и всё, что начислили живые невозвращённые покупки.
- [ ] Звёзды, списанные за невозвращённый второй шанс, записаны в
  `continueStars`.
- [ ] Тестерам ставится знак, остальным нет.
- [ ] Режим без записи считает те же итоги и ничего не пишет. Повторный
  снимок отказывается.
- [ ] Миграция одна: колонка `tester_at` и таблица `tester_compensation`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные, интеграционный тест —
  в CI PR.

## PR

- **Заголовок:** `chore(api): Снимок компенсаций тестерам перед вайпом`
- **Метка:** `release: none` — до игрока дойдёт с T-0042 и T-0043
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СНИМОК КОМПЕНСАЦИЙ ПЕРЕД ВАЙПОМ**

  Перед вайпом сервер запишет, что вернуть каждому тестеру и какой бонус дать: после вайпа считать будет не из чего.

  🎁 **Что в снимке**

  • купленное за звёзды — ровно столько, сколько начислила покупка; возвращённые оплаты не в счёт
  • второй шанс за звёзды — запоминаются звёзды, при выдаче они станут самоцветами
  • бонус тестеру — 5 самоцветов за уровень, не больше 250; тестер — тот, кто сыграл хотя бы один забег
  • знак «Тестер» ставится сразу и навсегда
  ```
