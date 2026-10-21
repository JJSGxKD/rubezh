import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { lockSourceSlot, type SourceSlot } from "../attribution/source-slot.js";
import type { StartKind } from "../attribution/start-param.js";
import { PARTNER_RULES, PARTNER_STATUSES, bindsNewPlayers, type PartnerStatus } from "./partner-rules.js";

/**
 * Привязка игрока по ссылке партнёра (docs/23-referral-and-partner-program.md §5,
 * docs/35-stage4-plan.md Р96, T-0067). Игрок пришёл по ссылке с владельцем-партнёром —
 * кликом через переходник (`c-<клик>`) или прямой ссылкой (`l-<код>`) — и при первом
 * входе записывается за партнёром, если тот активен, аккаунт не старше окна привязки,
 * а слот источника свободен. Правило то же, что у кодов партнёра: старый игрок,
 * увидевший пост, приведённым не считается, а реферер или другой партнёр раньше —
 * привязки нет.
 */

export type LinkBindingDecision = "bind" | "no_partner" | "inactive" | "too_old" | "slot_taken";

/**
 * Привязывать ли по касанию: решение без базы. Порядок отказов — от «кому
 * привязывать» к «можно ли именно сейчас»: нет партнёра, он не активен, аккаунт
 * вышел за окно, слот занят.
 */
export function linkBindingDecision(input: { partnerStatus: PartnerStatus | null; accountAgeDays: number; slot: SourceSlot }): LinkBindingDecision {
  if (input.partnerStatus === null) return "no_partner";
  if (!bindsNewPlayers(input.partnerStatus)) return "inactive";
  if (input.accountAgeDays > PARTNER_RULES.bindWindowDays) return "too_old";
  if (input.slot !== "free") return "slot_taken";
  return "bind";
}

/** Касание сессии: вид и идентификатор из параметра запуска и время запуска. */
export interface LinkTouch {
  accountId: string;
  startKind: StartKind;
  /** код клика у `click`, код ссылки у `link` */
  startRef: string | null;
  at: Date;
}

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
const DAY_MS = 86_400_000;

const ownerRow = z.object({ code: z.string(), partner_id: z.string() });
const accountRow = z.object({ created_at: z.date() });
const partnerRow = z.object({ status: z.string() });

/** Статус из строки базы; незнакомый — `null`, как «партнёра нет». */
function statusOf(raw: unknown): PartnerStatus | null {
  const { status } = partnerRow.parse(raw);
  return PARTNER_STATUSES.find((known) => known === status) ?? null;
}

@Injectable()
export class PartnerLinkBinder {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Записать игрока за партнёром ссылки, по которой он запустил игру. Ответ — решение: `bind`
   * значит, что игрок записан (или уже был записан этой же сессией — повтор безвреден), прочее —
   * почему нет. Касание не по ссылке партнёра — `no_partner`.
   *
   * Блокировка слота берётся только когда у ссылки есть владелец: основной поток входов, а это
   * ссылки команды и органика, до неё не доходит.
   */
  async bindFromTouch(touch: LinkTouch): Promise<LinkBindingDecision> {
    const owner = await this.ownerOf(touch);
    if (owner === null) return "no_partner";
    return await this.prisma.$transaction(async (tx): Promise<LinkBindingDecision> => {
      const slot = await lockSourceSlot(tx, touch.accountId);
      const [account] = await tx.$queryRaw<unknown[]>`SELECT created_at FROM account WHERE account_id = ${touch.accountId}::uuid`;
      const [partner] = await tx.$queryRaw<unknown[]>`SELECT status FROM partner WHERE partner_id = ${owner.partnerId}::uuid`;
      // Аккаунта нет — привязывать некого: возраст считаем вышедшим за окно. Статус, которого код не знает
      // (из будущей версии), партнёра активным не делает.
      const decision = linkBindingDecision({
        partnerStatus: partner === undefined ? null : statusOf(partner),
        accountAgeDays: account === undefined ? Number.POSITIVE_INFINITY : (touch.at.getTime() - accountRow.parse(account).created_at.getTime()) / DAY_MS,
        slot,
      });
      if (decision !== "bind") return decision;
      // Слот под блокировкой свободен, так что дубля быть не должно; первичный ключ — последний
      // рубеж, и повтор не роняет задание очереди.
      await tx.$executeRaw`
        INSERT INTO partner_binding (account_id, partner_id, campaign_id, link_code, bound_at)
        VALUES (${touch.accountId}::uuid, ${owner.partnerId}::uuid, NULL, ${owner.code}, ${touch.at})
        ON CONFLICT (account_id) DO NOTHING`;
      return decision;
    }, TX_OPTIONS);
  }

  /** Ссылка касания и её партнёр; `null` — касание не по ссылке, ссылки нет или у неё нет владельца. */
  private async ownerOf(touch: LinkTouch): Promise<{ code: string; partnerId: string } | null> {
    if (touch.startRef === null) return null;
    let rows: unknown[];
    if (touch.startKind === "link") {
      rows = await this.prisma.$queryRaw<unknown[]>`SELECT code, partner_id::text AS partner_id FROM link WHERE code = ${touch.startRef} AND partner_id IS NOT NULL`;
    } else if (touch.startKind === "click") {
      rows = await this.prisma.$queryRaw<unknown[]>`
        SELECT l.code, l.partner_id::text AS partner_id
        FROM link_click c JOIN link l ON l.code = c.link_code
        WHERE c.click_id = ${touch.startRef} AND l.partner_id IS NOT NULL`;
    } else {
      return null;
    }
    const [raw] = rows;
    if (raw === undefined) return null;
    const row = ownerRow.parse(raw);
    return { code: row.code, partnerId: row.partner_id };
  }
}
