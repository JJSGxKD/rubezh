import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Слот источника игрока (docs/23-referral-and-partner-program.md §5): кто
 * его привёл — реферер (`referral_binding`) или партнёр (`partner_binding`).
 * Слот один и заполняется однажды, первым касанием: код партнёра не
 * перебивает приглашение друга, а ссылка друга — код партнёра, иначе
 * появляется рынок «перебивания» чужих игроков.
 *
 * Привязки живут в двух таблицах двух модулей, поэтому «свободен ли слот» и
 * запись решаются под одной блокировкой аккаунта в транзакции записи: два
 * пути разом — ссылка друга при входе и код партнёра — не займут слот
 * оба. Отклонённая антифродом привязка друга слот тоже занимает: это та же
 * попытка привести игрока, только не засчитанная.
 */
export type SourceSlot = "free" | "referral" | "partner";

export async function lockSourceSlot(tx: Prisma.TransactionClient, accountId: string): Promise<SourceSlot> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`source_slot:${accountId}`}))`;
  const [row] = await tx.$queryRaw<{ referral: boolean; partner: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM referral_binding WHERE referred_account_id = ${accountId}::uuid) AS referral,
           EXISTS (SELECT 1 FROM partner_binding WHERE account_id = ${accountId}::uuid) AS partner`;
  if (row?.referral === true) return "referral";
  if (row?.partner === true) return "partner";
  return "free";
}
