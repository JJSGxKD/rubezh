import { describe, expect, it, vi } from "vitest";
import { openInvoiceWith, type InvoiceSdk } from "../src/invoice";

// Окно оплаты Stars (docs/34-stage3-plan.md, WP5): ответ окна сводится к
// статусу и никогда не бросает — решает всё равно сервер.

const URL = "https://t.me/$invoice";

function sdk(patch: Partial<InvoiceSdk> = {}): InvoiceSdk {
  return { isAvailable: () => true, open: async () => "paid", ...patch };
}

describe("окно оплаты Telegram", () => {
  it("передаёт ответ окна как есть", async () => {
    for (const status of ["paid", "pending", "cancelled", "failed"]) {
      await expect(openInvoiceWith(sdk({ open: async () => status }), URL)).resolves.toBe(status);
    }
  });

  it("вне клиента или в старом клиенте окна нет — так и говорит, а не бросает", async () => {
    const open = vi.fn();
    await expect(openInvoiceWith(sdk({ isAvailable: () => false, open }), URL)).resolves.toBe("unsupported");
    expect(open).not.toHaveBeenCalled();
  });

  it("незнакомый статус и сбой окна — неудача: ждать подтверждения не от чего", async () => {
    await expect(openInvoiceWith(sdk({ open: async () => "something_new" }), URL)).resolves.toBe("failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(openInvoiceWith(sdk({ open: async () => Promise.reject(new Error("ConcurrentCallError")) }), URL)).resolves.toBe("failed");
    warn.mockRestore();
  });
});
