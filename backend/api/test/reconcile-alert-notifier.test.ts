import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { ReconcileAlertNotifier, reconcileAlertText, type ReconcileAlertApi } from "../src/modules/admin-notify/reconcile-alert-notifier.js";
import { PaymentsHooks, type ReconcileFound } from "../src/modules/payments/payments-hooks.js";
import type { AdminChats, NotifyTargets } from "../src/modules/settings/notify-targets.js";
import { targetsOf } from "./helpers/notify-targets.js";

/**
 * Сообщение команде о новых расхождениях сверки оплат (tasks/T-0433, Р209):
 * одно на сверку, нашедшую новое, в поток «Покупки», а пока он не задан — в
 * общий чат; текст дословный, строки видов — только ненулевые.
 */

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_CHAT_ID: "-1001234567890", TELEGRAM_BOT_TOKEN: "123:TEST", ...patch } as NodeJS.ProcessEnv);
}

function event(patch: Partial<ReconcileFound> = {}): ReconcileFound {
  return {
    platform: "telegram",
    found: 3,
    open: 4,
    kinds: { charged_unrecorded: 2, recorded_missing: 1 },
    at: new Date("2026-11-13T12:00:00Z"),
    ...patch,
  };
}

function setup(cfg: AppConfig = config(), targets: NotifyTargets = targetsOf(cfg)) {
  const sent: { chat: unknown; text: string }[] = [];
  const hooks = new PaymentsHooks();
  const api: ReconcileAlertApi = { sendMessage: async (chat, text) => (sent.push({ chat, text }), 1) };
  const notifier = new ReconcileAlertNotifier(cfg, targets, hooks, api);
  return { notifier, sent, hooks, api };
}

let logged: { level: string; event: string }[];

beforeEach(() => {
  logged = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logged.push({ level, event: String((JSON.parse(String(message)) as Record<string, unknown>).event) });
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileAlertText: текст сообщения", () => {
  it("дословно: заголовок с числом, ненулевые виды в порядке, открытых всего, куда идти", () => {
    expect(reconcileAlertText(event())).toBe(
      [
        "🧾 Сверка с Telegram: новых расхождений — 3",
        "Списано, но не записано: 2",
        "Записано, но нет в выписке: 1",
        "Открытых всего: 4",
        "Разобрать: панель → «Платежи» → «Расхождения».",
      ].join("\n"),
    );
  });

  it("все три вида — в порядке «списано», «записано», «возврат»", () => {
    const text = reconcileAlertText(event({ found: 6, open: 6, kinds: { refund_unrecorded: 3, charged_unrecorded: 1, recorded_missing: 2 } }));

    expect(text.split("\n")).toEqual([
      "🧾 Сверка с Telegram: новых расхождений — 6",
      "Списано, но не записано: 1",
      "Записано, но нет в выписке: 2",
      "Возврат в Telegram, но не у нас: 3",
      "Открытых всего: 6",
      "Разобрать: панель → «Платежи» → «Расхождения».",
    ]);
  });

  it("строк нулевых видов нет: и записанных нулём, и пропущенных", () => {
    const text = reconcileAlertText(event({ found: 1, open: 1, kinds: { refund_unrecorded: 1, charged_unrecorded: 0 } }));

    expect(text).toContain("Возврат в Telegram, но не у нас: 1");
    expect(text).not.toContain("Списано, но не записано");
    expect(text).not.toContain("Записано, но нет в выписке");
    expect(text).not.toContain(": 0");
  });

  it.each([
    ["telegram" as const, "Telegram"],
    ["max" as const, "MAX"],
    ["vk" as const, "VK"],
    ["web" as const, "веб"],
  ])("площадка %s называется «%s»", (platform, name) => {
    expect(reconcileAlertText(event({ platform })).split("\n")[0]).toBe(`🧾 Сверка с ${name}: новых расхождений — 3`);
  });
});

describe("сообщение команде о расхождениях сверки", () => {
  it("событие сверки — одно сообщение в общий чат", async () => {
    const { notifier, sent, hooks } = setup();
    notifier.onModuleInit();

    await hooks.emitReconcileFound(event());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chat).toEqual({ chatId: "-1001234567890", threadId: null });
    expect(sent[0]?.text).toBe(reconcileAlertText(event()));
  });

  it("свой поток «Покупки» получает сообщение вместо общего чата", async () => {
    const chats = { general: { chatId: "-100", threadId: null }, payments: { chatId: "-100", threadId: 57 } } as AdminChats;
    const { notifier, sent, hooks } = setup(config(), { chats: () => chats } as NotifyTargets);
    notifier.onModuleInit();

    await hooks.emitReconcileFound(event());

    expect(sent[0]?.chat).toEqual({ chatId: "-100", threadId: 57 });
  });

  it("без дедупликации: две сверки подряд — два сообщения, каждая сверка своя", async () => {
    const { notifier, sent, hooks } = setup();
    notifier.onModuleInit();

    await hooks.emitReconcileFound(event());
    await hooks.emitReconcileFound(event());

    expect(sent).toHaveLength(2);
  });

  it("нет чата — не отправляет и не бросает, в лог — предупреждение", async () => {
    const { notifier, sent, hooks } = setup(config({ ADMIN_CHAT_ID: "" }));
    notifier.onModuleInit();

    await expect(hooks.emitReconcileFound(event())).resolves.toBeUndefined();
    await expect(notifier.deliver(event())).resolves.toBeUndefined();

    expect(sent).toEqual([]);
    expect(logged).toContainEqual({ level: "warn", event: "reconcile_alert_no_chat" });
  });

  it("отправка упала — не бросает, в лог — предупреждение: сверка уже записана", async () => {
    const cfg = config();
    const hooks = new PaymentsHooks();
    const notifier = new ReconcileAlertNotifier(cfg, targetsOf(cfg), hooks, {
      sendMessage: async () => {
        throw new Error("Telegram недоступен");
      },
    });
    notifier.onModuleInit();

    await expect(hooks.emitReconcileFound(event())).resolves.toBeUndefined();

    expect(logged).toContainEqual({ level: "warn", event: "reconcile_alert_failed" });
  });

  it("без токена бота на событие не подписывается", async () => {
    const { notifier, sent, hooks } = setup(config({ TELEGRAM_BOT_TOKEN: "" }));
    notifier.onModuleInit();

    await hooks.emitReconcileFound(event());

    expect(sent).toEqual([]);
    expect(logged).toEqual([]);
  });
});
