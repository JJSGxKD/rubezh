import { describe, expect, it } from "vitest";
import { hasTranslation } from "../src/i18n";
import { sessionNoticeOf } from "../src/state/session-notice";
import { AUTH_FAILURES, type AuthFailure } from "../src/state/auth-api";

// Что игрок видит, когда сессии нет (docs/34-stage3-plan.md, WP7). Критерий
// приёмки пакета — ни одно состояние не показывает пустоту или английский
// текст ошибки, поэтому проверяется каждый отказ входа, а не выборка.

function failed(failure: AuthFailure, message: string | null = null) {
  return { status: "failed" as const, failure, message };
}

describe("состояние входа для игрока", () => {
  it("на каждый отказ входа — русский текст из словаря или честное молчание", () => {
    for (const failure of AUTH_FAILURES) {
      const notice = sessionNoticeOf(failed(failure), true);
      if (failure === "disabled") {
        // Авторизация выключена в сборке или на сервере — сообщать нечего.
        expect(notice).toBeNull();
        continue;
      }
      expect(notice, failure).not.toBeNull();
      expect(hasTranslation(`session.${notice?.kind ?? ""}`), failure).toBe(true);
      expect(notice?.text, failure).toMatch(/[а-яё]/i);
    }
  });

  it("разные причины — разные советы: мимо Telegram не помогает «проверь связь»", () => {
    expect(sessionNoticeOf(failed("no_identity"), true)?.kind).toBe("outside");
    expect(sessionNoticeOf(failed("offline"), true)?.kind).toBe("offline");
    expect(sessionNoticeOf(failed("unavailable"), true)?.kind).toBe("offline");
    expect(sessionNoticeOf(failed("unauthorized"), true)?.kind).toBe("stale");
  });

  it("повторить предлагается только там, где повтор может помочь", () => {
    const retryable = AUTH_FAILURES.filter((failure) => sessionNoticeOf(failed(failure), true)?.retry === true);
    expect(retryable.sort()).toEqual(["offline", "unavailable"]);
  });

  it("у блокировки — причина от сервера: придумать её клиент не может", () => {
    expect(sessionNoticeOf(failed("banned", "Читы в забегах"), true)?.text).toContain("Читы в забегах");
    expect(sessionNoticeOf(failed("banned"), true)?.text).toBe("Аккаунт заблокирован.");
  });

  it("пока вход идёт или удался — молчит; в сборке без авторизации — тоже", () => {
    expect(sessionNoticeOf({ status: "signing", failure: null, message: null }, true)).toBeNull();
    expect(sessionNoticeOf({ status: "ready", failure: null, message: null }, true)).toBeNull();
    expect(sessionNoticeOf(failed("offline"), false)).toBeNull();
  });
});
