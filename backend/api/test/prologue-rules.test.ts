import { describe, expect, it } from "vitest";
import { runRecordingSchema } from "../src/modules/diagnostics/dto/run-report.dto.js";
import { DomainError } from "../src/common/domain-error.js";
import {
  PROLOGUE_DIFFICULTY,
  PROLOGUE_MIN_SEC,
  PrologueDifficultyError,
  PrologueRequiredError,
  admitMode,
  isPrologueWin,
  prologueGrantKey,
  prologueRewardLines,
  requireSectionsOpen,
  sectionsOpen,
} from "../src/modules/runs/prologue-rules.js";
import { RUN_MODES } from "../src/modules/runs/run-rules.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { EARN_REASONS } from "../src/modules/wallet/wallet-types.js";

/**
 * Правила пролога (tasks/T-0279, Р151): кого пускать в пролог, что считать
 * победой и когда закрыты «Награда дня» и «Задания». Чистые функции — без базы
 * и часов; запись, награда и закрытые разделы на живой базе — в
 * `prologue.integration.test.ts`.
 */

const DONE = new Date("2026-10-26T10:00:00.000Z");

describe("допуск к прологу", () => {
  it("пролог на сложной не принимается: 400 run_invalid", () => {
    expect(() => admitMode({ mode: "prologue", difficulty: "hard", doneAt: null })).toThrow(PrologueDifficultyError);
    try {
      admitMode({ mode: "prologue", difficulty: "normal", doneAt: null });
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("run_invalid");
      expect((error as DomainError).status).toBe(400);
    }
  });

  it("сложность проверяется и у аккаунта, уже прошедшего пролог: старый клиент с битым телом получает тот же отказ", () => {
    expect(() => admitMode({ mode: "prologue", difficulty: "hard", doneAt: DONE })).toThrow(PrologueDifficultyError);
  });

  it("пролог на лёгкой при пустом признаке — пролог", () => {
    expect(PROLOGUE_DIFFICULTY).toBe("easy");
    expect(admitMode({ mode: "prologue", difficulty: "easy", doneAt: null })).toBe("prologue");
  });

  it("пролог при заполненном признаке — обычный забег без наград пролога", () => {
    expect(admitMode({ mode: "prologue", difficulty: "easy", doneAt: DONE })).toBe("endless");
  });

  it("старый клиент без mode и явный endless — обычный забег на любой сложности, с признаком и без", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      for (const doneAt of [null, DONE]) {
        expect(admitMode({ mode: undefined, difficulty, doneAt })).toBe("endless");
        expect(admitMode({ mode: "endless", difficulty, doneAt })).toBe("endless");
      }
    }
  });

  it("список режимов сервера — endless и prologue", () => {
    expect([...RUN_MODES]).toEqual(["endless", "prologue"]);
  });
});

describe("запись забега для перепроверки", () => {
  it("схема записи диагностики несёт режим: без него повтор пролога собрал бы обычный мир", () => {
    const mode = runRecordingSchema.shape.mode;
    expect(mode.safeParse("prologue").data).toBe("prologue");
    expect(mode.safeParse("endless").data).toBe("endless");
    // Запись обычного забега поля не несёт.
    expect(mode.safeParse(undefined).success).toBe(true);
    expect(mode.safeParse("tutorial").success).toBe(false);
  });
});

describe("победа в прологе", () => {
  const win = { mode: "prologue", won: true, sec: 170, survivalSec: 170, verdict: "ok" } as const;

  it("победа — флаг клиента в прологе и вердикт, не равный отказу", () => {
    expect(isPrologueWin(win)).toBe(true);
    // Подозрительный забег — повод посмотреть, а не приговор (как у награды за забег).
    expect(isPrologueWin({ ...win, verdict: "suspicious" })).toBe(true);
  });

  it("отклонённый забег пролога не выигран, даже с флагом победы", () => {
    expect(isPrologueWin({ ...win, verdict: "rejected" })).toBe(false);
  });

  it("выход без победы и тело без поля пролога — не победа", () => {
    expect(isPrologueWin({ ...win, won: false })).toBe(false);
    expect(isPrologueWin({ ...win, won: undefined, sec: undefined })).toBe(false);
  });

  it("флаг победы в обычном забеге ничего не значит: награды пролога им не получить", () => {
    expect(isPrologueWin({ ...win, mode: "endless" })).toBe(false);
  });

  it("подделка: победа на тридцатой секунде — не победа, Страж приходит на 160-й", () => {
    expect(isPrologueWin({ ...win, sec: 30, survivalSec: 30 })).toBe(false);
    // Секунда победы сходится с длиной, но забег короче пролога.
    expect(isPrologueWin({ ...win, sec: PROLOGUE_MIN_SEC - 1, survivalSec: PROLOGUE_MIN_SEC - 1 })).toBe(false);
  });

  it("подделка: секунда победы не сходится с длиной забега больше чем на секунду", () => {
    // Длинный забег с «победой» на короткой секунде и наоборот.
    expect(isPrologueWin({ ...win, sec: 30, survivalSec: 170 })).toBe(false);
    expect(isPrologueWin({ ...win, sec: 300, survivalSec: 170 })).toBe(false);
    expect(isPrologueWin({ ...win, sec: 168.9, survivalSec: 170 })).toBe(false);
  });

  it("границы: ровно секунда расхождения и ровно минимальная длина проходят", () => {
    expect(isPrologueWin({ ...win, sec: 169, survivalSec: 170 })).toBe(true);
    expect(isPrologueWin({ ...win, sec: 171, survivalSec: 170 })).toBe(true);
    expect(isPrologueWin({ ...win, sec: PROLOGUE_MIN_SEC, survivalSec: PROLOGUE_MIN_SEC })).toBe(true);
  });

  it("победа без секунды в теле не засчитывается", () => {
    expect(isPrologueWin({ ...win, sec: undefined })).toBe(false);
  });
});

describe("закрытые разделы", () => {
  it("пока признак пуст — закрыты, с заполненным — открыты", () => {
    expect(sectionsOpen(null)).toBe(false);
    expect(sectionsOpen(DONE)).toBe(true);
  });

  it("закрытый раздел отвечает 409 prologue_required", () => {
    try {
      requireSectionsOpen(null);
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PrologueRequiredError);
      expect((error as DomainError).code).toBe("prologue_required");
      expect((error as DomainError).status).toBe(409);
    }
  });

  it("открытый раздел не бросает", () => {
    expect(() => requireSectionsOpen(DONE)).not.toThrow();
  });
});

describe("награда пролога", () => {
  it("ключи начислений — на аккаунт, а не на забег: пролог платит один раз, какой бы забег ни выиграл", () => {
    expect(prologueGrantKey("acc-1", "coins")).toBe("prologue:acc-1");
    expect(prologueGrantKey("acc-1", "gems")).toBe("prologue:acc-1:gems");
    expect(prologueGrantKey("acc-1", "coins")).not.toBe(prologueGrantKey("acc-2", "coins"));
  });

  it("строки награды — только ненулевые: панель вправе обнулить любую", () => {
    expect(prologueRewardLines(500, 10)).toEqual([
      { resource: "coins", amount: 500 },
      { resource: "gems", amount: 10 },
    ]);
    expect(prologueRewardLines(0, 10)).toEqual([{ resource: "gems", amount: 10 }]);
    expect(prologueRewardLines(500, 0)).toEqual([{ resource: "coins", amount: 500 }]);
    expect(prologueRewardLines(0, 0)).toEqual([]);
  });

  it("умолчания — 500 монет и 10 самоцветов, ключи prologue.reward-*", () => {
    expect(SETTINGS.prologueRewardCoins.key).toBe("prologue.reward-coins");
    expect(SETTINGS.prologueRewardGems.key).toBe("prologue.reward-gems");
    expect(SETTINGS.prologueRewardCoins.fallback).toBe(500);
    expect(SETTINGS.prologueRewardGems.fallback).toBe(10);
  });

  it("prologue_reward — начисление из ничего с суточным потолком ровно в награду: панель не поднимет её выше потолка", () => {
    expect(EARN_REASONS).toContain("prologue_reward");
    expect(WALLET_DAILY_CAPS.prologue_reward).toEqual({ coins: 500, gems: 10 });
    expect(SETTINGS.prologueRewardCoins.range?.max).toBe(WALLET_DAILY_CAPS.prologue_reward.coins);
    expect(SETTINGS.prologueRewardGems.range?.max).toBe(WALLET_DAILY_CAPS.prologue_reward.gems);
  });
});
