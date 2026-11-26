import { describe, expect, it } from "vitest";
import { actionTitle } from "../src/api/audit";
import { AdminApi } from "../src/api/client";
import {
  KIND_TITLES,
  MATERIAL_LIMITS,
  archiveMaterial,
  audienceTitle,
  bannerFileName,
  bannerSize,
  createMaterial,
  emptyMaterialForm,
  fetchCabinetMaterials,
  fitBanner,
  materialBody,
  materialFormOf,
  materialProblems,
  teamOrder,
  updateMaterial,
  type MaterialForm,
  type TeamMaterial,
} from "../src/api/partner-materials";
import { fakeFetch, json } from "./helpers";

/**
 * Материалы для партнёров в панели (docs/35-stage4-plan.md Р136, tasks/T-0221): форма проверяется теми же правилами,
 * что сервер, тело запроса не несёт лишнего, баннер приводится к сторонам профиля, а кабинет разбирает ответ схемой.
 * Тесты лежат вне зон задачи — отступление записано в PR.
 */

const PARTNER = "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e";
const IMAGE = "a".repeat(64);

function form(patch: Partial<MaterialForm>): MaterialForm {
  return { ...emptyMaterialForm("post"), title: "Текст для анонса", text: "Играйте в «Рубеж»", ...patch };
}

function material(patch: Partial<TeamMaterial>): TeamMaterial {
  return {
    materialId: "m1",
    kind: "post",
    title: "Пост",
    text: "Текст",
    imageId: null,
    partnerId: null,
    partnerName: null,
    sort: 0,
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
    archivedAt: null,
    imageWidth: null,
    imageHeight: null,
    ...patch,
  };
}

describe("форма материала", () => {
  it("баннер без картинки, пост без текста, пустое название и текст в 2001 знак — с понятной ошибкой у поля", () => {
    expect(materialProblems(form({ kind: "banner", text: "", imageId: null }))).toEqual({ imageId: "Загрузите картинку баннера" });
    expect(materialProblems(form({ kind: "post", text: "   " }))).toEqual({ text: "Нужен текст" });
    expect(materialProblems(form({ kind: "rules", text: "" }))).toEqual({ text: "Нужен текст" });
    expect(materialProblems(form({ title: "  " }))).toEqual({ title: "Название обязательно" });
    expect(materialProblems(form({ title: "я".repeat(81) })).title).toContain("80");
    expect(materialProblems(form({ text: "я".repeat(MATERIAL_LIMITS.textMax + 1) })).text).toContain("2000");
  });

  it("годные формы: баннер с подписью и без, текст ровно в 2000 знаков", () => {
    expect(materialProblems(form({ kind: "banner", text: "", imageId: IMAGE }))).toEqual({});
    expect(materialProblems(form({ kind: "banner", text: "Подпись", imageId: IMAGE }))).toEqual({});
    expect(materialProblems(form({ text: "я".repeat(MATERIAL_LIMITS.textMax) }))).toEqual({});
  });

  it("порядок — целое от 0 до 9999", () => {
    expect(materialProblems(form({ sort: "9999" }))).toEqual({});
    for (const sort of ["", "-1", "1.5", "10000", "abc"]) expect(materialProblems(form({ sort })).sort, sort).toBeDefined();
  });

  it("в тело уходит только то, что нужно серверу: у текста картинки нет, пустой текст — null, «всем» — null", () => {
    expect(materialBody(form({ kind: "post", imageId: IMAGE, partnerId: "" }))).toEqual({ kind: "post", title: "Текст для анонса", text: "Играйте в «Рубеж»", imageId: null, partnerId: null, sort: 0 });
    expect(materialBody(form({ kind: "banner", title: " Баннер ", text: "  ", imageId: IMAGE, partnerId: PARTNER, sort: "3" }))).toEqual({ kind: "banner", title: "Баннер", text: null, imageId: IMAGE, partnerId: PARTNER, sort: 3 });
  });

  it("правка открывается с тем, что сохранено", () => {
    expect(materialFormOf(material({ kind: "banner", text: null, imageId: IMAGE, partnerId: PARTNER, sort: 7 }))).toEqual({ kind: "banner", title: "Пост", text: "", imageId: IMAGE, partnerId: PARTNER, sort: "7" });
  });
});

describe("баннер: стороны профиля partner_material", () => {
  it("крупный уменьшается пропорционально до 2048, обычный остаётся как есть", () => {
    expect(fitBanner(1080, 1080)).toEqual({ ok: true, width: 1080, height: 1080 });
    expect(fitBanner(4096, 2048)).toEqual({ ok: true, width: 2048, height: 1024 });
    expect(fitBanner(200, 2048)).toEqual({ ok: true, width: 200, height: 2048 });
  });

  it("мельче 200 px по короткой стороне и слишком вытянутая после уменьшения — отказ словами", () => {
    expect(fitBanner(199, 600)).toMatchObject({ ok: false, problem: expect.stringContaining("200") });
    expect(fitBanner(5000, 400)).toMatchObject({ ok: false, problem: expect.stringContaining("вытянута") });
  });

  it("размер на карточке и имя файла скачивания", () => {
    expect(bannerSize({ imageWidth: 1080, imageHeight: 1080 })).toBe("1080×1080");
    expect(bannerSize({ imageWidth: null, imageHeight: null })).toBeNull();
    expect(bannerFileName("Баннер для поста 1080×1080")).toBe("баннер-для-поста-1080-1080.webp");
    expect(bannerFileName("???")).toBe("banner.webp");
    expect(bannerFileName("../../etc/passwd")).toBe("etc-passwd.webp");
  });
});

describe("таблица команды", () => {
  it("живые по порядку кабинета, архивные — в конце; получатель словами", () => {
    const list = [
      material({ materialId: "archive", sort: 0, archivedAt: "2026-10-25T00:00:00.000Z" }),
      material({ materialId: "late", sort: 5 }),
      material({ materialId: "early", sort: 1, createdAt: "2026-10-23T09:00:00.000Z" }),
      material({ materialId: "tie", sort: 1 }),
    ];
    expect(teamOrder(list).map((item) => item.materialId)).toEqual(["early", "tie", "late", "archive"]);
    expect(audienceTitle({ partnerId: null, partnerName: null })).toBe("Все партнёры");
    expect(audienceTitle({ partnerId: PARTNER, partnerName: "Игровой угол" })).toBe("Игровой угол");
    expect(KIND_TITLES.banner).toBe("Баннер");
  });

  it("действия материалов записываются в журнал словами, а не кодами", () => {
    expect(actionTitle("partner_material.create")).toBe("Новый материал для партнёров");
    expect(actionTitle("partner_material.update")).toBe("Правка материала для партнёров");
    expect(actionTitle("partner_material.archive")).toBe("Материал для партнёров в архиве");
    expect(actionTitle("partner_material.restore")).toBe("Материал для партнёров из архива");
  });
});

describe("запросы", () => {
  it("кабинет: свой — без partnerId, глазами партнёра — с ним; ответ разбирается схемой, лишних полей чужих нет", async () => {
    const body = { materials: [{ materialId: "m1", kind: "banner", title: "Баннер", text: null, imageId: IMAGE, imageWidth: 1080, imageHeight: 1080, shared: true }], viewOnly: false };
    const { fetch, calls } = fakeFetch(json(200, { data: body }), json(200, { data: { materials: [], viewOnly: true } }));
    const api = new AdminApi(fetch);

    const own = await fetchCabinetMaterials(api, null);
    const seen = await fetchCabinetMaterials(api, PARTNER);

    expect(calls[0]?.url).toBe("/api/v1/admin/cabinet/materials");
    expect(calls[1]?.url).toBe(`/api/v1/admin/cabinet/materials?partnerId=${PARTNER}`);
    expect(own.ok && own.data.materials[0]).toMatchObject({ kind: "banner", imageWidth: 1080, shared: true });
    expect(seen.ok && seen.data.viewOnly).toBe(true);
  });

  it("ответ не по схеме — ошибка, а не таблица с undefined", async () => {
    const { fetch } = fakeFetch(json(200, { data: { materials: [{ materialId: "m1", kind: "video" }], viewOnly: false } }));
    expect((await fetchCabinetMaterials(new AdminApi(fetch), null)).ok).toBe(false);
  });

  it("новый, правка и архив идут своими маршрутами и методами", async () => {
    const saved = material({ materialId: "m9" });
    const { fetch, calls } = fakeFetch(json(200, { data: saved }), json(200, { data: saved }), json(200, { data: saved }), json(200, { data: saved }));
    const api = new AdminApi(fetch);

    await createMaterial(api, form({}));
    await updateMaterial(api, "m9", form({ title: "Новое" }));
    await archiveMaterial(api, "m9", true);
    await archiveMaterial(api, "m9", false);

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "/api/v1/admin/partner-materials"],
      ["POST", "/api/v1/admin/partner-materials/m9"],
      ["PUT", "/api/v1/admin/partner-materials/m9/archive"],
      ["PUT", "/api/v1/admin/partner-materials/m9/archive"],
    ]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ archived: true });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ archived: false });
  });
});
