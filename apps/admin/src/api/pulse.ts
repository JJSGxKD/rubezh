import { z } from "zod";
import type { Route } from "../routes";
import type { AdminApi, ApiResult } from "./client";

/**
 * Строка «пульса» в шапке (`GET /admin/pulse`, tasks/T-0360): онлайн сейчас,
 * ход идущей рассылки и блокировки клиента за час. Часть `null` — нет права или
 * источник не ответил.
 */

export const pulseResponseSchema = z.object({
  online: z.object({ total: z.number() }).nullable(),
  broadcast: z.object({ id: z.string(), percent: z.number() }).nullable(),
  csp: z.object({ hosts: z.number() }).nullable(),
});
export type Pulse = z.infer<typeof pulseResponseSchema>;

export interface PulsePart {
  key: "online" | "broadcast" | "csp";
  text: string;
  route: Route;
  /** точка «в сети» перед текстом */
  dot: boolean;
}

export function fetchPulse(api: AdminApi): Promise<ApiResult<Pulse>> {
  return api.request("/pulse", { schema: pulseResponseSchema });
}

/** Части строки по порядку; пустая часть не показывается, блокировок ноль — «тихо, значит хорошо». */
export function pulseParts(pulse: Pulse): PulsePart[] {
  const parts: PulsePart[] = [];
  if (pulse.online !== null) parts.push({ key: "online", text: `${String(pulse.online.total)} онлайн`, route: { section: "online", id: null }, dot: true });
  if (pulse.broadcast !== null) parts.push({ key: "broadcast", text: `рассылка ${String(pulse.broadcast.percent)}%`, route: { section: "broadcasts", id: pulse.broadcast.id }, dot: false });
  if (pulse.csp !== null && pulse.csp.hosts > 0) parts.push({ key: "csp", text: `CSP ${String(pulse.csp.hosts)} за час`, route: { section: "csp", id: null }, dot: false });
  return parts;
}
