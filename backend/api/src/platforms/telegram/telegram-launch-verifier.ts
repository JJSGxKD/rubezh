import type { LaunchCheck, LaunchVerifier } from "../ports/launch-verifier.js";
import { verifyInitData } from "./telegram-init-data.js";

/**
 * Проверка запуска Telegram — подпись `initData` токеном бота
 * (`telegram-init-data.ts`). Причины отказа сводятся к тем, что нужны
 * домену: устарело — открыть заново, остальное — не наш игрок.
 */
export class TelegramLaunchVerifier implements LaunchVerifier {
  readonly platform = "telegram" as const;
  readonly authScheme = "tma";

  constructor(private readonly botToken: string) {}

  get configured(): boolean {
    return this.botToken !== "";
  }

  verify(raw: string, maxAgeSec: number, nowMs: number): LaunchCheck {
    if (!this.configured) return { ok: false, reason: "unsupported" };
    const check = verifyInitData(raw, this.botToken, maxAgeSec, nowMs);
    if (!check.ok) return { ok: false, reason: check.reason === "expired" ? "expired" : "invalid" };
    return { ok: true, player: check.player, signedAtSec: check.authDate, startParam: check.startParam };
  }
}
