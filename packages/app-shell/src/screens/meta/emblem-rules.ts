import { t } from "../../i18n";
import "../../i18n/emblems";
import { rarityLook } from "./rarity-look";

/**
 * Правила знаков у имени (tasks/T-0236, docs/35-stage4-plan.md Р149): порядок
 * групп, название знака, порог «значок или значок с названием», тон. Чистые
 * функции без React — чтобы порядок и пороги проверялись тестами, а не глазами.
 */

/** Группы раздела «Знаки» по порядку; группа без знаков не рисуется. */
export const GROUP_ORDER = ["status", "season", "merit"] as const;
export type EmblemGroup = (typeof GROUP_ORDER)[number];

export interface EmblemGroupItems<T> {
  category: EmblemGroup;
  items: T[];
}

function groupOf(category: string): EmblemGroup {
  return GROUP_ORDER.find((group) => group === category) ?? "merit";
}

/**
 * Знаки по группам в порядке `GROUP_ORDER`: внутри группы держимые сверху,
 * затем закрытые, порядок сервера сохраняется. Категория, которой клиент не
 * знает (сервер новее), идёт в «Заслуги»: знак не должен пропадать, а новая
 * группа без названия в словаре показала бы игроку ключ.
 */
export function groupEmblems<T extends { category: string; held: boolean }>(items: readonly T[]): EmblemGroupItems<T>[] {
  return GROUP_ORDER.flatMap((category) => {
    const inGroup = items.filter((item) => groupOf(item.category) === category);
    const ordered = [...inGroup.filter((item) => item.held), ...inGroup.filter((item) => !item.held)];
    return ordered.length === 0 ? [] : [{ category, items: ordered }];
  });
}

/** Сколько знаков держит игрок — число на кнопке «Знаки · N». */
export function heldCount(items: readonly { held: boolean }[]): number {
  return items.filter((item) => item.held).length;
}

/** Название знака; у сезонного — с номером сезона: «Чемпион · сезон 3». */
export function emblemLabel(emblem: { title: string; season?: number | undefined }): string {
  return emblem.season === undefined ? emblem.title : t("emblems.season", { title: emblem.title, season: emblem.season });
}

/** С этой ширины экрана знак в строке списка — значок с названием; уже — только значок (`meta-v2.md` §1.5: «имя важнее»). */
export const EMBLEM_FIT_MIN_WIDTH = 360;

export type EmblemFit = "full" | "glyph";

export function emblemFit(width: number): EmblemFit {
  return width >= EMBLEM_FIT_MIN_WIDTH ? "full" : "glyph";
}

/**
 * Цвет знака — токен: у `team` бирюза оберегов, у `partner` акцент, у остальных
 * тон редкости предмета (`rarity-look.ts`); незнакомая редкость рисуется как обычная.
 */
export function emblemTone(tier: string): string {
  if (tier === "team") return "var(--color-secondary)";
  if (tier === "partner") return "var(--color-accent)";
  return rarityLook(tier).tone;
}

/**
 * Цвет значка внутри чипа. У обычной редкости тон — цвет обводки плитки
 * (`--color-border-strong`), и значком на тёмном он не читается (3:1 для
 * значков, `docs/27` §4): значок берёт цвет текста, а обводка — тон.
 */
export function emblemInk(tier: string): string {
  const tone = emblemTone(tier);
  return tone === rarityLook("common").tone ? "var(--color-text)" : tone;
}
