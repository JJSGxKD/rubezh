import { CURRENCIES, MANUAL_RATE_PURPOSES, isCurrencyCode, manualRate, type CurrencyCode, type ManualRatePurpose } from "@bh/fx";
import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { PrismaRateStore } from "../modules/fx/fx.store.js";
import { PrismaRolesRepository } from "../modules/roles/roles.repository.js";

/**
 * Заданные курсы валют площадок с сервера (docs/35-stage4-plan.md, §3.12,
 * Р37) — пока нет раздела курсов в панели, и при подъёме нового окружения.
 *
 *   pnpm --filter backend-api fx:manual                         — что стоит сейчас
 *   pnpm --filter backend-api fx:manual XTR price 1.72 RUB 90 "прайс-лист клиента Telegram"
 *   pnpm --filter backend-api fx:manual XTR payout 0.013 USD 90 "вывод звёзд"
 *
 * Аргументы: валюта, цель (price — цена для игрока, payout — выплата нам),
 * цена единицы, валюта котировки, срок годности в днях, причина. Каждая
 * установка — строка в журнале аудита от имени системы. В контейнере —
 * `node dist/cli/fx-manual.js`.
 */

const DAY_MS = 86_400_000;
const MAX_DAYS = 90;

async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  const store = new PrismaRateStore(prisma);
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      for (const code of Object.keys(CURRENCIES) as CurrencyCode[]) {
        if (CURRENCIES[code].kind !== "platform") continue;
        for (const purpose of MANUAL_RATE_PURPOSES) {
          const rate = await store.currentManual(code, purpose);
          console.log(`${code} ${purpose}: ${rate === null ? "не задан" : `${rate.price.toFixed()} ${rate.quote} до ${rate.expiresAt.toISOString().slice(0, 10)} — ${rate.note}`}`);
        }
      }
      return;
    }

    const [code, purpose, price, quote, daysArg, ...noteParts] = args;
    const note = noteParts.join(" ").trim();
    const days = Number(daysArg);
    if (code === undefined || !isCurrencyCode(code) || CURRENCIES[code].kind !== "platform") throw new Error(`Валюта — валюта площадки, например XTR, а не «${String(code)}»`);
    if (!(MANUAL_RATE_PURPOSES as readonly string[]).includes(purpose ?? "")) throw new Error(`Цель — ${MANUAL_RATE_PURPOSES.join(" или ")}`);
    if (quote === undefined || !isCurrencyCode(quote) || CURRENCIES[quote].kind !== "fiat") throw new Error("Котировка — фиат: USD, EUR или RUB");
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`Срок — от 1 до ${MAX_DAYS} дней`);
    if (note.length < 3) throw new Error("Нужна причина — она уходит в журнал аудита");

    const now = new Date();
    const rate = manualRate({
      currency: code,
      purpose: purpose as ManualRatePurpose,
      price: price ?? "",
      quote,
      setBy: "cli",
      setAt: now,
      expiresAt: new Date(now.getTime() + days * DAY_MS),
      note,
    });
    const before = await store.currentManual(code, rate.purpose);
    await store.appendManual(rate);
    await new PrismaRolesRepository(prisma).append({
      actorAccountId: null,
      action: "fx.manual_rate",
      target: `${code}:${rate.purpose}`,
      before: before === null ? null : { price: before.price.toFixed(), quote: before.quote, expiresAt: before.expiresAt.toISOString() },
      after: { price: rate.price.toFixed(), quote: rate.quote, expiresAt: rate.expiresAt.toISOString(), note, via: "cli" },
    });
    console.log(`${code} ${rate.purpose}: ${rate.price.toFixed()} ${rate.quote} до ${rate.expiresAt.toISOString().slice(0, 10)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
