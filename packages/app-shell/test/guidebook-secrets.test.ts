import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SECRET_KINDS, type SecretKind } from "@bh/shared-types";
import { hasTranslation, t } from "../src/i18n";
import "../src/i18n/guide";
import ruGuide from "../src/i18n/ru-guide.json";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { SecretsCodex, createSecretsCodexApi, loadSecretsCodexState, secretsFoundOf } from "../src/screens/guide/secrets";
import { hex } from "../src/screens/guide/scenes";
import { SECRET_LOOKS } from "@bh/core-game";

// Кодекс тайников в гайдбуке (tasks/T-0261, design/art/meta-v2.md §5.3):
// ответ сервера — граница системы и разбирается схемой; найденный тайник
// показывает облик, имя и предание, ненайденный — силуэт без них; гость и ошибка
// сети видят раздел без отметок.

function server(answer: unknown): ApiRequest {
  return async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const render = (found: readonly SecretKind[]): string => renderToStaticMarkup(createElement(SecretsCodex, { found }));

describe("ответ сервера", () => {
  it("разбирается: список найденных видов", async () => {
    const result = await createSecretsCodexApi(server({ found: ["shrine", "hoard"] })).load();
    expect(result.ok && result.data.found).toEqual(["shrine", "hoard"]);
  });

  it("не разбирается без списка и с видом не из шести: сервер новее клиента не должен ронять гайдбук молча", async () => {
    expect((await createSecretsCodexApi(server({})).load()).ok).toBe(false);
    expect((await createSecretsCodexApi(server({ found: ["shrine", "ghost"] })).load()).ok).toBe(false);
  });
});

describe("состояние кодекса", () => {
  it("ответ получен — готово, найденные берутся из ответа", async () => {
    const state = await loadSecretsCodexState(createSecretsCodexApi(server({ found: ["tree"] })), true);
    expect(state.status).toBe("ready");
    expect(secretsFoundOf(state)).toEqual(["tree"]);
  });

  it("сеть или сервер подвели — ошибка, найденных нет", async () => {
    const failing: ApiRequest = async () => ({ ok: false, failure: "offline" });
    const state = await loadSecretsCodexState(createSecretsCodexApi(failing), true);
    expect(state.status).toBe("error");
    expect(secretsFoundOf(state)).toEqual([]);
  });

  it("гость и старый сервер — «недоступно»: запрос для гостя не уходит", async () => {
    let asked = false;
    const spy: ApiRequest = async () => {
      asked = true;
      return { ok: false, failure: "disabled" };
    };
    expect((await loadSecretsCodexState(createSecretsCodexApi(spy), false)).status).toBe("unavailable");
    expect(asked).toBe(false);
    expect((await loadSecretsCodexState(createSecretsCodexApi(async () => ({ ok: false, failure: "disabled" })), true)).status).toBe("unavailable");
  });
});

describe("раздел «Тайники»", () => {
  it("«Найдено: 2 из 6» и шесть карточек, по одной на вид", () => {
    const markup = render(["shrine", "hoard"]);
    expect(markup).toContain("Найдено: 2 из 6");
    expect(markup).toContain(t("guidebook.secrets"));
    for (const kind of SECRET_KINDS) expect(markup, kind).toContain(`data-secret="${kind}"`);
  });

  it("найденный: облик в своём цвете, имя и предание", () => {
    const markup = render(["shrine", "hoard"]);
    for (const kind of ["shrine", "hoard"] as const) {
      expect(markup, kind).toContain(t(`secret.${kind}.name`));
      expect(markup, kind).toContain(t(`secret.${kind}.lore`));
      expect(markup, kind).toContain(hex(SECRET_LOOKS[kind].color));
    }
  });

  it("ненайденный: силуэт и «Ещё не найден», ни имени, ни предания, ни цвета вида", () => {
    const markup = render(["shrine", "hoard"]);
    for (const kind of ["tree", "rift", "stone", "wisp"] as const) {
      expect(markup, kind).not.toContain(t(`secret.${kind}.name`));
      expect(markup, kind).not.toContain(t(`secret.${kind}.lore`));
      expect(markup, kind).not.toContain(hex(SECRET_LOOKS[kind].color));
    }
    expect(markup.split(t("guidebook.secrets.unknown")).length - 1).toBe(4);
  });

  it("ничего не найдено — «Найдено: 0 из 6», все шесть закрыты", () => {
    const markup = render([]);
    expect(markup).toContain("Найдено: 0 из 6");
    expect(markup.split(t("guidebook.secrets.unknown")).length - 1).toBe(6);
    for (const kind of SECRET_KINDS) expect(markup, kind).not.toContain(t(`secret.${kind}.lore`));
  });

  it("все шесть найдены — «Найдено: 6 из 6», закрытых нет", () => {
    const markup = render([...SECRET_KINDS]);
    expect(markup).toContain("Найдено: 6 из 6");
    expect(markup).not.toContain(t("guidebook.secrets.unknown"));
  });

  it("повтор и вид не из шести в списке не раздувают счёт", () => {
    const markup = render(["shrine", "shrine", "ghost"] as unknown as SecretKind[]);
    expect(markup).toContain("Найдено: 1 из 6");
  });

  it("полоса прогресса — родной <progress> со значением для скринридера", () => {
    const markup = render(["shrine", "hoard"]);
    expect(markup).toContain("<progress");
    expect(markup).toContain('value="2"');
    expect(markup).toContain('max="6"');
  });
});

describe("тексты", () => {
  const dictionary = ruGuide as Record<string, string>;

  it("предания — дословно из задачи", () => {
    expect(dictionary["secret.shrine.lore"]).toBe("Здесь молились тем, кто держал рубеж до нас. Постой — и они ответят.");
    expect(dictionary["secret.hoard.lore"]).toBe("Кто-то закопал добро и не вернулся. Теперь оно твоё — если успеешь выкопать.");
    expect(dictionary["secret.tree.lore"]).toBe("Старое дерево помнит первых хранителей. В его тени раны затягиваются.");
    expect(dictionary["secret.rift.lore"]).toBe("Здесь Навь подошла слишком близко. Шагни — и она шагнёт навстречу.");
    expect(dictionary["secret.stone.lore"]).toBe("Камень ставили дозорные: коснись — и увидишь, что они отметили.");
    expect(dictionary["secret.wisp.lore"]).toBe("Огонёк знает дорогу. Иди за ним — он не обманет.");
  });

  it("слова раздела — дословно из задачи", () => {
    expect(dictionary["guidebook.secrets"]).toBe("Тайники");
    expect(dictionary["guidebook.secrets.found"]).toBe("Найдено: {count} из {total}");
    expect(dictionary["guidebook.secrets.unknown"]).toBe("Ещё не найден");
  });

  it("все ключи раздела лежат в словаре гайдбука и не пусты, вкладка названа", () => {
    const keys = [
      "guide.tab.secrets",
      "guidebook.secrets",
      "guidebook.secrets.found",
      "guidebook.secrets.unknown",
      "guidebook.secrets.error",
      "guidebook.secrets.guest",
      ...SECRET_KINDS.map((kind) => `secret.${kind}.lore`),
    ];
    for (const key of keys) {
      expect(dictionary[key], key).toBeTruthy();
      expect(hasTranslation(key), key).toBe(true);
    }
  });

  it("имена видов уже есть в основном словаре — гайдбук их не дублирует", () => {
    for (const kind of SECRET_KINDS) {
      expect(dictionary[`secret.${kind}.name`], kind).toBeUndefined();
      expect(hasTranslation(`secret.${kind}.name`), kind).toBe(true);
    }
  });
});
