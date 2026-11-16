import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { AuthHooks, type LoginEvent } from "../auth/auth-hooks.js";
import { TELEGRAM_AFFILIATE_REPOSITORY, type MarkOutcome, type TelegramAffiliateRepository } from "./telegram-affiliate.repository.js";

/**
 * Метка партнёрки Telegram у игрока (docs/35-stage4-plan.md Р97, T-0072): вход по ссылке программы
 * бота (`_tgr_<id>`) помечает аккаунт навсегда и закрывает слот источника — реферер и партнёр к
 * нему уже не привязываются. Метка ничего не выдаёт игроку: она нужна, чтобы правила программы
 * Telegram не нарушались вторым источником, и будущей бухгалтерии (WP50).
 *
 * Слушатель входа, как `SessionRecorder`: вход его не ждёт (`auth-hooks.ts`), а запись метки идёт
 * мимо очереди сессий — решение о слоте принимается в транзакции под блокировкой аккаунта, и
 * опереться на асинхронную запись касаний нельзя. Ошибку базы слушатель не глотает: `AuthHooks`
 * запишет её как `login_listener_failed`, а метка поставится при следующем приходе по ссылке.
 */

export type MarkerResult = MarkOutcome | { status: "skipped" };

@Injectable()
export class TelegramAffiliateMarker implements OnModuleInit {
  private readonly logger = new Logger("attribution");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: AuthHooks,
    @Inject(TELEGRAM_AFFILIATE_REPOSITORY) private readonly marks: TelegramAffiliateRepository,
  ) {}

  onModuleInit(): void {
    if (this.config.auth.enabled) this.hooks.onLogin("telegram-affiliate", async (login) => void (await this.onLogin(login)));
  }

  async onLogin(login: LoginEvent): Promise<MarkerResult> {
    // Повторный вход посреди работы — не запуск игры.
    if (login.reason !== "launch") return { status: "skipped" };
    // На других площадках `_tgr_<id>` — просто чужой текст.
    if (login.platform !== "telegram") return { status: "skipped" };
    const { kind, raw, ref } = login.startParam;
    if (kind !== "telegram_affiliate" || raw === null || ref === null) return { status: "skipped" };

    const outcome = await this.marks.mark({ accountId: login.accountId, startParam: raw, ref, at: login.at });
    // «Уже помечен» — самый частый исход, и в журнал он шумом: запись метки видна по таблице.
    if (outcome.status === "marked") this.log("telegram_affiliate_marked", login, ref);
    else if (outcome.status === "slot_taken") this.log("telegram_affiliate_slot_taken", login, ref, outcome.slot);
    return outcome;
  }

  private log(event: string, login: LoginEvent, ref: string, slot?: "referral" | "partner"): void {
    const fields = { module: "attribution", event, accountId: login.accountId, ref, place: login.place, created: login.created };
    this.logger.log(JSON.stringify(slot === undefined ? fields : { ...fields, slot }));
  }
}
