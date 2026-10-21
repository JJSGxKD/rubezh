import { describe, expect, it } from "vitest";
import { modalFooterPlacement, modalMount } from "../src/design-system/components/modal-rules";

// Где живёт подвал модалки: закреплять нечего без подвала, поэтому опция без
// `footer` не должна снимать у тела нижний отступ.

describe("место подвала модалки", () => {
  it("без подвала — «none», закрепление не действует", () => {
    expect(modalFooterPlacement({ hasFooter: false, pinFooter: false })).toBe("none");
    expect(modalFooterPlacement({ hasFooter: false, pinFooter: true })).toBe("none");
  });

  it("с подвалом без опции — «scroll», как у всех существующих модалок", () => {
    expect(modalFooterPlacement({ hasFooter: true, pinFooter: false })).toBe("scroll");
  });

  it("с подвалом и опцией — «pinned»", () => {
    expect(modalFooterPlacement({ hasFooter: true, pinFooter: true })).toBe("pinned");
  });
});

describe("куда рисовать модалку", () => {
  it("слоя нет (undefined) — на месте: витрина, предпросмотр, серверный рендер", () => {
    expect(modalMount(undefined)).toBe("inline");
  });

  it("слой есть, узла ещё нет (null) — ждём, на месте не рисуем", () => {
    expect(modalMount(null)).toBe("wait");
  });

  it("узел слоя есть — рисуем в него", () => {
    expect(modalMount({})).toBe("portal");
  });
});
