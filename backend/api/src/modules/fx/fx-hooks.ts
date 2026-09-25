import { Injectable, Logger } from "@nestjs/common";
import type { CurrencyCode, ManualRatePurpose } from "@bh/fx";

/**
 * Алерты курсов (docs/35-stage4-plan.md, §3.12): `rate_rejected` — скачок
 * без подтверждения или несогласные источники, `rate_stale` — курс устарел,
 * просрочен или его нет, и отказ источника. Модуль курсов — домен и в чат
 * команды сам не пишет (граница слоёв): доставку берёт `admin-notify`,
 * подписавшись здесь, как на записанные забеги.
 *
 * Слушатель зовётся без ожидания, и его ошибка проход обновления не роняет.
 */

export type FxAlert =
  | { kind: "rate_rejected"; currency: CurrencyCode; reason: "jump_unconfirmed" | "sources_disagree"; candidate: string; previous: string | null }
  | { kind: "rate_stale"; currency: CurrencyCode; state: "stale" | "expired" | "missing"; purpose: ManualRatePurpose | null }
  | { kind: "source_failed"; source: string; reason: string };

type Listener = (alert: FxAlert) => Promise<void>;

@Injectable()
export class FxHooks {
  private readonly logger = new Logger("fx");
  private readonly listeners = new Map<string, Listener>();

  onAlert(name: string, listener: Listener): void {
    this.listeners.set(name, listener);
  }

  emit(alert: FxAlert): void {
    for (const [name, listener] of this.listeners) {
      void listener(alert).catch((error: unknown) => {
        this.logger.warn(JSON.stringify({ module: "fx", event: "alert_listener_failed", listener: name, reason: error instanceof Error ? error.message : "unknown" }));
      });
    }
  }
}
