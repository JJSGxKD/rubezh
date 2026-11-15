import { Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { BroadcastsService } from "../broadcasts/broadcasts.service.js";
import { CspReportsService } from "../csp-reports/csp-reports.service.js";
import { OnlineService } from "../online/online.service.js";
import { permissionsOf } from "../roles/permissions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";

/**
 * Пульс для шапки панели (tasks/T-0360): онлайн, ход идущей рассылки и
 * блокировки клиента за час. Часть без права или с упавшим источником — `null`:
 * один источник не роняет строку.
 */

const READ_TIMEOUT_MS = 5_000;
const HOUR_MS = 3_600_000;

export interface Pulse {
  online: { total: number } | null;
  broadcast: { id: string; percent: number } | null;
  /** пары «директива · адрес», получившие отчёт за последний час */
  csp: { hosts: number } | null;
}

@Injectable()
export class AdminPulseService {
  private readonly logger = new Logger("admin-pulse");

  constructor(
    private readonly roles: RolesService,
    private readonly online: OnlineService,
    private readonly broadcasts: BroadcastsService,
    private readonly csp: CspReportsService,
  ) {}

  async pulse(actor: AccountRef, now = new Date()): Promise<Pulse> {
    const can = permissionsOf(await this.roles.rolesFor(actor));
    const [online, broadcast, csp] = await Promise.all([
      can.has("analytics.gameplay.view") ? this.safely("онлайн", () => this.onlineNow()) : null,
      can.has("broadcast.edit") ? this.safely("рассылка", () => this.runningBroadcast(actor)) : null,
      can.has("diagnostics.view") ? this.safely("блокировки клиента", () => this.cspLastHour(now)) : null,
    ]);
    return { online, broadcast, csp };
  }

  private async onlineNow(): Promise<{ total: number }> {
    const snapshot = await withTimeout(this.online.adminSnapshot(), READ_TIMEOUT_MS, "пульс: онлайн");
    return { total: snapshot.total.app };
  }

  /** Идущая рассылка; их несколько — начатая раньше. Процент — доля доставленных от набранных. */
  private async runningBroadcast(actor: AccountRef): Promise<Pulse["broadcast"]> {
    const all = await withTimeout(this.broadcasts.list(actor), READ_TIMEOUT_MS, "пульс: рассылки");
    const running = all
      .filter((broadcast) => broadcast.status === "sending")
      .sort((a, b) => (a.startedAt?.getTime() ?? a.createdAt.getTime()) - (b.startedAt?.getTime() ?? b.createdAt.getTime()))[0];
    if (running === undefined) return null;
    const view = await withTimeout(this.broadcasts.view(actor, running.broadcastId), READ_TIMEOUT_MS, "пульс: ход рассылки");
    const stats = view.stats;
    const total = stats === null ? 0 : stats.queued + stats.sent + stats.blocked + stats.failed;
    return { id: running.broadcastId, percent: stats === null || total === 0 ? 0 : Math.round((stats.sent / total) * 100) };
  }

  private async cspLastHour(now: Date): Promise<{ hosts: number }> {
    const { entries } = await withTimeout(this.csp.summary(), READ_TIMEOUT_MS, "пульс: блокировки клиента");
    const since = now.getTime() - HOUR_MS;
    return { hosts: entries.filter((entry) => Date.parse(entry.lastAt) >= since).length };
  }

  private async safely<T>(source: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error: unknown) {
      this.logger.warn(`пульс без части «${source}»: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }
}
