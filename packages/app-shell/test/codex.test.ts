import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "@bh/core-game";
import { hasTranslation, t } from "../src/i18n";
import "../src/i18n/guide";
import ruGuide from "../src/i18n/ru-guide.json";
import ruTasks from "../src/i18n/ru-tasks.json";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { codexOpenedSet, createCodexApi, loadCodexState, type CodexView } from "../src/state/codex-api";
import { eliteEnemies, regularEnemies, toGuideEnemy } from "../src/screens/guide/guide-data";
import { CodexBar, LockedEnemyCard } from "../src/screens/guide/codex";

// Кодекс врагов в гайдбуке (tasks/T-0127, docs/39-retention-mechanics.md К2):
// ответ сервера — граница системы и разбирается схемой; закрытая запись не
// выдаёт ни названия, ни описания врага; гость и ошибка сети видят гайдбук
// как раньше.

function server(answer: unknown): ApiRequest {
  return async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const REWARD = { taskId: "ach_codex_100", value: 63, target: 100, done: false, claimed: false, coins: 400, prestige: 20 };

function view(opened: number, patch: Partial<CodexView> = {}): CodexView {
  return {
    total: 11,
    opened: ENEMIES.slice(0, opened).map((enemy) => ({ enemy: enemy.id, firstSeenAt: "2026-10-20T10:00:00.000Z" })),
    percent: Math.floor((opened * 100) / 11),
    reward: REWARD,
    ...patch,
  };
}

describe("ответ сервера", () => {
  it("разбирается с наградой и с reward: null", async () => {
    const api = createCodexApi(server({ total: 11, opened: [{ enemy: "swarm_rat", firstSeenAt: "2026-10-20T10:00:00.000Z" }], percent: 9, reward: REWARD }));
    const first = await api.load();
    expect(first.ok && first.data.reward?.coins).toBe(400);
    const second = await createCodexApi(server({ total: 11, opened: [], percent: 0, reward: null })).load();
    expect(second.ok && second.data.reward).toBeNull();
  });

  it("не разбирается без списка записей: сервер новее клиента не должен ронять гайдбук молча", async () => {
    const result = await createCodexApi(server({ total: 11, percent: 0, reward: null })).load();
    expect(result.ok).toBe(false);
  });
});

describe("состояние кодекса", () => {
  it("ответ получен — готово, открытые id берутся из записей", async () => {
    const state = await loadCodexState(createCodexApi(server(view(3))), true);
    expect(state.status).toBe("ready");
    expect(codexOpenedSet(state)?.size).toBe(3);
  });

  it("сеть или сервер подвели — ошибка, и все враги показываются открытыми", async () => {
    const failing: ApiRequest = async () => ({ ok: false, failure: "offline" });
    const state = await loadCodexState(createCodexApi(failing), true);
    expect(state.status).toBe("error");
    expect(codexOpenedSet(state)).toBeNull();
  });

  it("гость и старый сервер — «недоступно»: запрос не уходит, враги открыты", async () => {
    let asked = false;
    const spy: ApiRequest = async () => {
      asked = true;
      return { ok: false, failure: "disabled" };
    };
    const guest = await loadCodexState(createCodexApi(spy), false);
    expect(guest.status).toBe("unavailable");
    expect(asked).toBe(false);
    expect(codexOpenedSet(guest)).toBeNull();
    const old = await loadCodexState(createCodexApi(async () => ({ ok: false, failure: "disabled" })), true);
    expect(old.status).toBe("unavailable");
  });
});

describe("записи гайдбука", () => {
  it("toGuideEnemy для гостя и ошибки отдаёт opened: true, список без аргумента открыт целиком", () => {
    const def = ENEMIES[0];
    if (def === undefined) throw new Error("в контенте нет врагов");
    expect(toGuideEnemy(def).opened).toBe(true);
    for (const enemy of [...regularEnemies(), ...eliteEnemies()]) expect(enemy.opened, enemy.def.id).toBe(true);
    for (const enemy of [...regularEnemies(null), ...eliteEnemies(null)]) expect(enemy.opened, enemy.def.id).toBe(true);
  });

  it("с множеством открытых закрыты все остальные, а состав по-прежнему собирается из контента", () => {
    const open = new Set([ENEMIES[0]?.id ?? ""]);
    const all = [...regularEnemies(open), ...eliteEnemies(open)];
    expect(all.map((enemy) => enemy.def.id).sort()).toEqual(ENEMIES.map((enemy) => enemy.id).sort());
    expect(all.filter((enemy) => enemy.opened)).toHaveLength(1);
  });

  it("закрытая запись не содержит названия и описания врага, но называет группу и подсказку", () => {
    for (const def of ENEMIES) {
      const group = def.rank === "boss" ? "boss" : def.rank === "elite" ? "elite" : "regular";
      const markup = renderToStaticMarkup(createElement(LockedEnemyCard, { enemy: toGuideEnemy(def, false), index: 0 }));
      expect(markup, def.id).not.toContain(t(`enemy.${def.id}.name`));
      expect(markup, def.id).not.toContain(t(`guide.pattern.${def.pattern}.name`));
      expect(markup, def.id).not.toContain(t(`guide.pattern.${def.pattern}.text`));
      expect(markup, def.id).not.toContain(t(`guide.pattern.${def.pattern}.tip`));
      expect(markup, def.id).not.toContain(def.id);
      expect(markup, def.id).toContain(t("guide.codex.locked.name"));
      expect(markup, def.id).toContain(t("guide.codex.locked.hint"));
      expect(markup, def.id).toContain(t(`guide.codex.group.${group}`));
    }
  });
});

describe("полоса кодекса", () => {
  it("показывает «Открыто 7 из 11» и заголовок", () => {
    const markup = renderToStaticMarkup(createElement(CodexBar, { opened: 7, total: 11, reward: REWARD, onClaim: () => undefined }));
    expect(markup).toContain("Кодекс врагов");
    expect(markup).toContain("Открыто 7 из 11");
    expect(markup).toContain("<progress");
  });

  it("награду за полный кодекс называет числами сервера; кнопка только у готовой и не забранной", () => {
    const text = renderToStaticMarkup(createElement(CodexBar, { opened: 7, total: 11, reward: REWARD, onClaim: () => undefined }));
    expect(text).toContain("400 монет");
    expect(text).toContain("20 очков престижа");
    expect(text).not.toContain("Забрать награду");

    const ready = renderToStaticMarkup(createElement(CodexBar, { opened: 11, total: 11, reward: { ...REWARD, value: 100, done: true }, onClaim: () => undefined }));
    expect(ready).toContain("Забрать награду");

    const claimed = renderToStaticMarkup(createElement(CodexBar, { opened: 11, total: 11, reward: { ...REWARD, value: 100, done: true, claimed: true }, onClaim: () => undefined }));
    expect(claimed).toContain("Награда получена");
    expect(claimed).not.toContain("Забрать награду");
  });

  it("награды нет (выключена в панели) — полоса без строки награды", () => {
    const markup = renderToStaticMarkup(createElement(CodexBar, { opened: 7, total: 11, reward: null, onClaim: () => undefined }));
    expect(markup).toContain("Открыто 7 из 11");
    expect(markup).not.toContain("За полный кодекс");
  });
});

describe("тексты", () => {
  const KEYS = [
    "guide.codex.title",
    "guide.codex.progress",
    "guide.codex.locked.name",
    "guide.codex.locked.hint",
    "guide.codex.group.regular",
    "guide.codex.group.elite",
    "guide.codex.group.boss",
    "guide.codex.reward",
    "guide.codex.claim",
    "guide.codex.claimed",
    "guide.codex.error",
  ];

  it("все ключи guide.codex.* лежат в ru-guide.json и не пусты", () => {
    const dictionary = ruGuide as Record<string, string>;
    for (const key of KEYS) expect(dictionary[key], key).toBeTruthy();
    for (const key of KEYS) expect(hasTranslation(key), key).toBe(true);
  });

  it("слова из задачи — дословно", () => {
    const dictionary = ruGuide as Record<string, string>;
    expect(dictionary["guide.codex.title"]).toBe("Кодекс врагов");
    expect(dictionary["guide.codex.progress"]).toBe("Открыто {opened} из {total}");
    expect(dictionary["guide.codex.locked.name"]).toBe("Неизвестный враг");
    expect(dictionary["guide.codex.locked.hint"]).toBe("Встреть его в забеге — и запись откроется.");
    expect(dictionary["guide.codex.error"]).toBe("Не удалось загрузить кодекс — враги показаны без отметок.");
  });

  it("цель достижения по виду codex_percent названа в словаре заданий", () => {
    expect((ruTasks as Record<string, string>)["task.kind.codex_percent"]).toBe("Открой {target}% записей в кодексе врагов");
  });
});
