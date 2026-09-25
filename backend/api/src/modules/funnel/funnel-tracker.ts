import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { AuthHooks } from "../auth/auth-hooks.js";
import { PaymentsHooks } from "../payments/payments-hooks.js";
import { RunsHooks } from "../runs/runs-hooks.js";
import { FUNNEL_REPOSITORY, type FunnelRepository } from "./funnel.repository.js";

/**
 * Кто ставит вехи воронки (docs/35-stage4-plan.md, §3.10): слушатели входа,
 * забегов и оплаты. Модули-источники о воронке не знают — подписывается она
 * сама, как атрибуция на вход.
 *
 * Веха не должна ронять событие: слушатели и так работают после ответа
 * игроку, а упавшая запись уходит в лог с аккаунтом — её восстановят из
 * сессий и забегов, если понадобится.
 */
@Injectable()
export class FunnelTracker implements OnModuleInit {
  private readonly logger = new Logger("funnel");

  constructor(
    @Inject(FUNNEL_REPOSITORY) private readonly funnel: FunnelRepository,
    private readonly auth: AuthHooks,
    private readonly runs: RunsHooks,
    private readonly payments: PaymentsHooks,
  ) {}

  onModuleInit(): void {
    this.auth.onLogin("funnel", async (login) => {
      if (login.place === "channel") return await this.mark("entered", login.accountId, () => this.funnel.entered(login.accountId, login.at));
      // Повторный вход посреди работы — та же сессия, а не новый запуск.
      if (login.reason !== "launch") return;
      await this.mark("app_opened", login.accountId, () => this.funnel.appOpened(login.accountId, login.at));
    });
    this.runs.onStarted("funnel", async (run) => {
      await this.mark("first_run_started", run.accountId, () => this.funnel.firstRunStarted(run.accountId, run.at));
    });
    this.runs.onRecorded("funnel", async (run) => {
      await this.mark("run_recorded", run.accountId, () => this.funnel.runRecorded(run.accountId, run.finishedAt));
    });
    this.payments.onPaid("funnel", async (purchase) => {
      // Тестовая оплата — проверка платёжной цепочки, а не покупка игрока.
      if (purchase.mode !== "live") return;
      await this.mark("first_purchase", purchase.accountId, () => this.funnel.firstPurchase(purchase.accountId, purchase.at));
    });
  }

  private async mark(step: string, accountId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "funnel", event: "step_lost", step, accountId, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
