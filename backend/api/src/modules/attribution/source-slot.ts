import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Слот источника игрока (docs/23-referral-and-partner-program.md §5): кто
 * его привёл — реферер (`referral_binding`), партнёр (`partner_binding`) или
 * партнёрская программа Telegram (`telegram_affiliate_mark`, Р97). Слот один и
 * заполняется однажды, первым касанием: код партнёра не перебивает приглашение
 * друга, а ссылка друга — код партнёра, иначе появляется рынок «перебивания»
 * чужих игроков. Метка Telegram ничего не выдаёт, но слот закрывает: правила
 * программы не допускают второго источника у её реферала.
 *
 * Привязки живут в трёх таблицах трёх модулей, поэтому «свободен ли слот» и
 * запись решаются под одной блокировкой аккаунта в транзакции записи: два
 * пути разом — ссылка друга при входе и код партнёра — не займут слот
 * оба. Отклонённая антифродом привязка друга слот тоже занимает: это та же
 * попытка привести игрока, только не засчитанная.
 */
export type SourceSlot = "free" | "referral" | "partner" | "telegram";

export async function lockSourceSlot(tx: Prisma.TransactionClient, accountId: string): Promise<SourceSlot> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`source_slot:${accountId}`}))`;
  const [row] = await tx.$queryRaw<{ referral: boolean; partner: boolean; telegram: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM referral_binding WHERE referred_account_id = ${accountId}::uuid) AS referral,
           EXISTS (SELECT 1 FROM partner_binding WHERE account_id = ${accountId}::uuid) AS partner,
           EXISTS (SELECT 1 FROM telegram_affiliate_mark WHERE account_id = ${accountId}::uuid) AS telegram`;
  if (row?.referral === true) return "referral";
  if (row?.partner === true) return "partner";
  if (row?.telegram === true) return "telegram";
  return "free";
}
