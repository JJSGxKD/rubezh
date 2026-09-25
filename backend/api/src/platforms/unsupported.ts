import type { LaunchCheck, LaunchVerifier } from "./ports/launch-verifier.js";
import type { PlatformId } from "./ports/platform.js";

/**
 * Площадка, адаптер которой ещё не написан: MAX и VK портируются на этапе 7
 * (`02-roadmap.md`). Заглушка честно отвечает «не умею», а не падает и не
 * притворяется: домен видит `unsupported` и говорит игроку то же, что и на
 * любой площадке без этой возможности.
 */
export class UnsupportedLaunchVerifier implements LaunchVerifier {
  readonly authScheme: string;
  readonly configured = false;

  constructor(readonly platform: PlatformId) {
    this.authScheme = platform;
  }

  verify(): LaunchCheck {
    return { ok: false, reason: "unsupported" };
  }
}
