import { describe, expect, it } from "vitest";
import { formatDuration, formatNumber } from "../src/i18n";
import { APPEARANCE_ORDER } from "../src/screens/meta/appearance-rules";
import {
  CARD_FROM,
  FAVORITES_SHOWN,
  actionFor,
  appearanceRarity,
  failureTextKey,
  favoritesShown,
  isPublicId,
  moreEmblems,
  relationAfterRequest,
  requestFailureKey,
  statCells,
  type CardNumbers,
} from "../src/screens/meta/player-card-rules";

// Правила карточки игрока (tasks/T-0248, docs/35-stage4-plan.md Р48): что
// делает кнопка для каждого отношения, сколько знаков «ещё», четыре числа с
// прочерком на пустом и откуда берётся тон сцены. Чистые функции без React.

describe("действие карточки по отношению", () => {
  it("none — кнопка «В друзья»", () => {
    expect(actionFor("none")).toEqual({ id: "add", labelKey: "playerCard.addFriend", mode: "button" });
  });

  it("outgoing — «Заявка отправлена», кнопка выключена", () => {
    expect(actionFor("outgoing")).toEqual({ id: "requested", labelKey: "playerCard.requested", mode: "disabled" });
  });

  it("incoming — «Принять заявку», кнопка работает", () => {
    expect(actionFor("incoming")).toEqual({ id: "accept", labelKey: "playerCard.accept", mode: "button" });
  });

  it("friend — метка «друзья» без кнопки", () => {
    expect(actionFor("friend")).toEqual({ id: "friends", labelKey: "playerCard.friends", mode: "label" });
  });

  it("self — действий нет", () => {
    expect(actionFor("self")).toBeNull();
  });

  it("отношение, которого клиент не знает (сервер новее), — действий нет, а не падение", () => {
    expect(actionFor("blocked")).toBeNull();
    expect(actionFor("")).toBeNull();
  });
});

describe("«+N» у знаков", () => {
  it("двенадцать знаков, показано пять — ещё семь", () => {
    expect(moreEmblems(12, 5)).toBe(7);
  });

  it("показано всё — ничего", () => {
    expect(moreEmblems(5, 5)).toBeNull();
    expect(moreEmblems(3, 5)).toBeNull();
    expect(moreEmblems(0, 0)).toBeNull();
  });

  it("мусор от сервера (отрицательное, не число) — ничего, а не «+-2»", () => {
    expect(moreEmblems(-1, 5)).toBeNull();
    expect(moreEmblems(Number.NaN, 5)).toBeNull();
  });
});

const NUMBERS: CardNumbers = { stats: { runs: 214, totalKills: 9_000, bestSurvivalSec: 760 }, power: 1_830, season: { place: 3 } };

describe("четыре числа карточки", () => {
  it("лучший забег, место в сезоне, забеги, мощь — в этом порядке", () => {
    expect(statCells(NUMBERS)).toEqual([
      { id: "best", labelKey: "playerCard.best", text: formatDuration(760) },
      { id: "place", labelKey: "playerCard.place", text: formatNumber(3) },
      { id: "runs", labelKey: "playerCard.runs", text: formatNumber(214) },
      { id: "power", labelKey: "playerCard.power", text: formatNumber(1_830) },
    ]);
  });

  it("лучший забег — минуты и секунды", () => {
    expect(statCells(NUMBERS)[0]?.text).toBe("12:40");
  });

  it("нет места в сезоне — «—»", () => {
    const cells = statCells({ ...NUMBERS, season: null });
    expect(cells.find((cell) => cell.id === "place")?.text).toBe("—");
  });

  it("новичок без забегов и снаряжения — «—» вместо нулей", () => {
    const cells = statCells({ stats: { runs: 0, totalKills: 0, bestSurvivalSec: 0 }, power: 0, season: null });
    expect(cells.map((cell) => cell.text)).toEqual(["—", "—", "—", "—"]);
  });
});

describe("витрина", () => {
  const favorites = [1, 2, 3, 4].map((index) => ({ id: `ach_${String(index)}`, title: `Достижение ${String(index)}`, category: "boss" }));

  it("не больше трёх любимых", () => {
    expect(FAVORITES_SHOWN).toBe(3);
    expect(favoritesShown(favorites).map((item) => item.id)).toEqual(["ach_1", "ach_2", "ach_3"]);
  });

  it("пусто — пусто", () => {
    expect(favoritesShown([])).toEqual([]);
  });
});

describe("тон сцены — редкость облика", () => {
  it("редкость каждого известного облика совпадает с каталогом сервера", () => {
    expect(APPEARANCE_ORDER.map((id) => appearanceRarity(id))).toEqual(["common", "common", "uncommon", "uncommon", "rare", "rare", "epic", "epic", "legendary", "mythic"]);
  });

  it("облик, которого клиент не знает, — обычный", () => {
    expect(appearanceRarity("dragon")).toBe("common");
  });
});

describe("публичный id", () => {
  it("двенадцать строчных шестнадцатеричных знаков", () => {
    expect(isPublicId("0a1b2c3d4e5f")).toBe(true);
  });

  it("всё остальное — нет: в путь запроса чужая строка не уходит", () => {
    expect(isPublicId("")).toBe(false);
    expect(isPublicId("0A1B2C3D4E5F")).toBe(false);
    expect(isPublicId("0a1b2c3d4e5")).toBe(false);
    expect(isPublicId("0a1b2c3d4e5f0")).toBe(false);
    expect(isPublicId("../friends/a")).toBe(false);
  });
});

describe("откуда открыта карточка", () => {
  it("четыре входа из спецификации", () => {
    expect([...CARD_FROM]).toEqual(["rating", "season", "friends", "profile"]);
  });
});

describe("текст отказа", () => {
  it("игрока нет — «Игрок не найден»", () => {
    expect(failureTextKey("not_found")).toBe("playerCard.notFound");
  });

  it("слишком часто — свой текст про минуту", () => {
    expect(failureTextKey("too_often")).toBe("playerCard.tooOften");
  });

  it("про связь и вход — общий текст экранов меты", () => {
    expect(failureTextKey("offline")).toBe("sync.failure.offline");
    expect(failureTextKey("unauthorized")).toBe("sync.failure.unauthorized");
    expect(failureTextKey("no_identity")).toBe("sync.failure.no_identity");
  });

  it("остальное — «не получилось», а не «рейтинг выключен»", () => {
    expect(failureTextKey("unavailable")).toBe("playerCard.failed");
    expect(failureTextKey("disabled")).toBe("playerCard.failed");
    expect(failureTextKey("rejected")).toBe("playerCard.failed");
  });
});

describe("заявка в друзья: отказ и исход", () => {
  it("отказы сервера — каждый свой текст", () => {
    expect(requestFailureKey("friend_not_found")).toBe("playerCard.notFound");
    expect(requestFailureKey("rate_limited")).toBe("playerCard.tooOften");
    expect(requestFailureKey("friend_limit")).toBe("playerCard.requestLimit");
  });

  it("себе, без кода, незнакомый код — «заявка не ушла»", () => {
    expect(requestFailureKey("validation_failed")).toBe("playerCard.requestFailed");
    expect(requestFailureKey(undefined)).toBe("playerCard.requestFailed");
    expect(requestFailureKey("something_new")).toBe("playerCard.requestFailed");
  });

  it("встречная заявка принята — друзья; иначе заявка ждёт ответа", () => {
    expect(relationAfterRequest("friends")).toBe("friend");
    expect(relationAfterRequest("requested")).toBe("outgoing");
    expect(relationAfterRequest("повтор")).toBe("outgoing");
  });
});
