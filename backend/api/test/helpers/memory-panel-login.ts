import type { PanelLoginRequest, PanelLoginStore } from "../../src/modules/admin/panel-login.store.js";

/**
 * Запросы входа в панель в памяти — для тестов сервиса и бота. Смысл тот же,
 * что у Redis: подтверждается только ждущий запрос, забирается только
 * подтверждённый и один раз. Сами скрипты проверяются на живом Redis.
 */
export class MemoryPanelLoginStore implements PanelLoginStore {
  readonly requests = new Map<string, PanelLoginRequest>();

  async create(requestId: string, request: PanelLoginRequest): Promise<void> {
    this.requests.set(requestId, { ...request });
  }

  async get(requestId: string): Promise<PanelLoginRequest | null> {
    const request = this.requests.get(requestId);
    return request === undefined ? null : { ...request };
  }

  async settle(requestId: string, status: "confirmed" | "declined", accountId: string | null, reason: string | null): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (request?.status !== "pending") return false;
    this.requests.set(requestId, { ...request, status, accountId, reason });
    return true;
  }

  async take(requestId: string): Promise<string | null> {
    const request = this.requests.get(requestId);
    if (request?.status !== "confirmed" || request.accountId === null) return null;
    this.requests.delete(requestId);
    return request.accountId;
  }
}
