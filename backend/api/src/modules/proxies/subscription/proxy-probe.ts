import type { ProbeResult } from "@bh/proxy-kit";
import type { OutboundProxy, ProxyFetch } from "../../../infra/outbound/outbound-route.js";
import { runProxyCheck } from "../proxy-check.js";

/**
 * Проверка узла подписки — тот же запрос на ipify через узел, что кнопка
 * «Проверить» у ручного прокси (`proxy-check.ts`, T-0065): живой узел отвечает
 * внешним адресом, а время ответа становится задержкой для выбора лучших.
 */
export async function probeNode(proxyFetch: ProxyFetch, node: OutboundProxy): Promise<ProbeResult> {
  const started = performance.now();
  const outcome = await runProxyCheck(proxyFetch, node);
  return outcome.ok ? { ok: true, latencyMs: Math.max(1, Math.round(performance.now() - started)) } : { ok: false };
}
