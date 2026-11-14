import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@bh/shared-types";
import { Avatar, AvatarFace } from "../src/design-system/components/Data";
import { appearanceHeadUrl } from "../src/screens/meta/appearance-art";
import { LeaderboardRow } from "../src/screens/meta/rating";

// Кружок аватара (tasks/T-0238, docs/35-stage4-plan.md Р47): голова облика —
// только зрителю с артом и только когда игрок не выбрал фото; иначе фото, потом
// инициалы, как до обликов.

const PHOTO = "https://t.me/i/userpic/photo.jpg";
const face = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(AvatarFace, { name: "Иван Петров", size: 36, viewerArt: true, ...props } as never));

describe("кружок: голова или фото", () => {
  it("зритель с артом, облик в строке — голова облика, а не фото", () => {
    const html = face({ url: PHOTO, appearance: "vityaz" });

    expect(html).toContain(`src="${appearanceHeadUrl("vityaz")}"`);
    expect(html).not.toContain(PHOTO);
  });

  it("игрок выбрал «фото из Telegram» — фото, хотя облик в строке есть", () => {
    const html = face({ url: PHOTO, appearance: "vityaz", avatarPhoto: true });

    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).not.toContain(appearanceHeadUrl("vityaz"));
  });

  it("зритель без арта видит фото игрока с артом, а не голову", () => {
    const html = face({ url: PHOTO, appearance: "knyaz", viewerArt: false });

    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).not.toContain(appearanceHeadUrl("knyaz"));
  });

  it("строка без облика (старый сервер) рисует фото, как сейчас", () => {
    expect(face({ url: PHOTO })).toContain(`src="${PHOTO}"`);
  });

  it("фото нет и головы нет — инициалы", () => {
    const html = face({ url: null, viewerArt: false, appearance: "vityaz" });

    expect(html).toContain(">ИП<");
    expect(html).not.toContain("<img");
  });

  it("облик, которого клиент не знает, — голова Хранителя", () => {
    expect(face({ url: PHOTO, appearance: "future" })).toContain(`src="${appearanceHeadUrl("keeper")}"`);
  });

  it("голова — круг того же размера, что фото, и без подписи: имя читает строка рядом", () => {
    const html = face({ url: null, appearance: "navi", size: 56 });

    expect(html).toContain('width="56"');
    expect(html).toContain('height="56"');
    expect(html).toContain('alt=""');
    expect(html).toContain("rounded-full");
  });
});

describe("кружок без арта у зрителя", () => {
  it("`Avatar` по умолчанию (флаги арта не пришли) рисует фото", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: "Иван Петров", url: PHOTO, appearance: "vityaz" }));

    expect(html).toContain(`src="${PHOTO}"`);
  });

  it("строка рейтинга с обликом у зрителя без арта показывает фото", () => {
    const entry: LeaderboardEntry = { rank: 3, name: "Мира", photoUrl: PHOTO, survivalSec: 700, level: 12, startingWeaponId: "spark", enemiesKilled: 300, isMe: false, appearance: "vityaz" };

    const html = renderToStaticMarkup(createElement(LeaderboardRow, { entry, index: 0 }));

    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).not.toContain(appearanceHeadUrl("vityaz"));
  });
});
