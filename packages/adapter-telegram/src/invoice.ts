import type { InvoiceStatus } from "@bh/shared-types";

/**
 * Окно оплаты Telegram — для счёта, который выставил сервер
 * (`createInvoiceLink`, docs/34-stage3-plan.md, WP5).
 *
 * Что ответило окно — подсказка, а не факт оплаты: продолжение выдаёт сервер
 * по подтверждению от Telegram (Р13). Поэтому ошибки здесь не бросаются, а
 * сводятся к статусу: оболочке нужно одно — ждать ли подтверждения сервера.
 */

/** Срез SDK, который нужен окну оплаты: так функция проверяется без клиента Telegram. */
export interface InvoiceSdk {
  isAvailable(): boolean;
  open(url: string): Promise<string>;
}

const KNOWN: ReadonlySet<string> = new Set(["paid", "pending", "cancelled", "failed"]);

export async function openInvoiceWith(sdk: InvoiceSdk, url: string): Promise<InvoiceStatus> {
  // Вне клиента или в клиенте старше 6.1 окна оплаты нет вовсе.
  if (!sdk.isAvailable()) return "unsupported";
  try {
    const status = await sdk.open(url);
    // Незнакомый статус — новый в Bot API. Оплачено ли, скажет сервер, а
    // окно для игрока закрылось без ясного ответа.
    return KNOWN.has(status) ? (status as InvoiceStatus) : "failed";
  } catch (error: unknown) {
    // Второе окно поверх открытого, битая ссылка, обрыв моста с клиентом.
    console.warn("Окно оплаты Telegram не открылось:", error);
    return "failed";
  }
}
