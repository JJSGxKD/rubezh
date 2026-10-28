import type { PromoDoc } from "./doc.js";

/** Переменные текста слоя в порядке, в котором редактор о них спрашивает. */
export const VAR_NAMES = ["code", "link", "reward"] as const;

export type VarName = (typeof VAR_NAMES)[number];

/** Значения переменных: промокод как его вводит игрок, ссылка, награда словами. */
export type PromoVars = Partial<Record<VarName, string>>;

const VAR_RE = /\{(code|link|reward)\}/g;

/**
 * Подставить переменные и отдать новый документ без них; исходный не меняется.
 * Переменной нет в `vars` — её место пустое, чтобы в картинку не попало
 * «undefined». У слоя `qr` без `link` ставится `hidden`, иначе он кодировал бы
 * пустоту; с `link` слой получает `data` — что кодировать.
 */
export function resolveDoc(doc: PromoDoc, vars: PromoVars): PromoDoc {
  const copy = structuredClone(doc);
  for (const layer of copy.layers) {
    if (layer.type === "text") {
      // Функция, а не строка замены: «$&» в коде не должен считаться шаблоном.
      layer.text = layer.text.replace(VAR_RE, (_, name: VarName) => vars[name] ?? "");
    } else if (layer.type === "qr") {
      if (vars.link === undefined || vars.link === "") layer.hidden = true;
      else layer.data = vars.link;
    }
  }
  return copy;
}

/**
 * Какие переменные нужны документу: редактор по ним решает, спрашивать ли код,
 * ссылку и награду. Слой `qr` требует `link`; скрытые слои не считаются.
 */
export function usedVars(doc: PromoDoc): VarName[] {
  const used = new Set<VarName>();
  for (const layer of doc.layers) {
    if (layer.hidden === true) continue;
    if (layer.type === "qr") used.add("link");
    if (layer.type !== "text") continue;
    for (const match of layer.text.matchAll(VAR_RE)) used.add(match[1] as VarName);
  }
  return VAR_NAMES.filter((name) => used.has(name));
}
