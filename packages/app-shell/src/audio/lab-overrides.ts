import type { KeyValueStorage } from "@bh/shared-types";
import { z } from "zod/mini";
import { SOUND_RECIPES, type SoundId, type SoundRecipe } from "./recipes";

/**
 * Правки звуков из лаборатории — на этом устройстве (docs/31-audio-and-haptics.md).
 * Тестер крутит числа на телефоне, слышит результат в игре и отправляет
 * команде копию; в код правка попадает через ревью, а не из хранилища.
 */
export const LAB_OVERRIDES_KEY = "bh.audio.lab.v1";

const frequency = z.number().check(z.minimum(1), z.maximum(24_000));
const seconds = z.number().check(z.minimum(0), z.maximum(10));
const amplitude = z.number().check(z.minimum(0), z.maximum(2));
const wave = z.optional(z.enum(["sine", "square", "sawtooth", "triangle"]));
const filterType = z.enum(["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"]);

const layerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tone"),
    wave,
    f0: frequency,
    f1: z.optional(frequency),
    glide: z.optional(seconds),
    t: z.optional(seconds),
    attack: z.optional(seconds),
    peak: amplitude,
    decay: seconds,
    detune: z.optional(z.number()),
  }),
  z.object({
    kind: z.literal("hiss"),
    filter: z.optional(filterType),
    f0: frequency,
    f1: z.optional(frequency),
    glide: z.optional(seconds),
    q: z.optional(z.number().check(z.minimum(0.0001), z.maximum(100))),
    t: z.optional(seconds),
    dur: seconds,
    attack: z.optional(seconds),
    peak: amplitude,
    decay: z.optional(seconds),
    seed: z.int(),
  }),
  z.object({
    kind: z.literal("bell"),
    f: frequency,
    t: z.optional(seconds),
    peak: z.optional(amplitude),
    decay: z.optional(seconds),
    ratio: z.optional(z.number().check(z.minimum(0.1), z.maximum(20))),
    index: z.optional(z.number().check(z.minimum(0), z.maximum(20))),
  }),
  z.object({
    kind: z.literal("swell"),
    wave,
    f0: frequency,
    f1: z.optional(frequency),
    glide: z.optional(seconds),
    t: z.optional(seconds),
    attack: seconds,
    hold: z.optional(seconds),
    release: seconds,
    peak: amplitude,
    detune: z.optional(z.array(z.number())),
    filter: z.optional(
      z.object({ type: filterType, f0: frequency, f1: z.optional(frequency), glide: z.optional(seconds), q: z.optional(z.number()) }),
    ),
  }),
]);

export const recipeSchema = z.object({
  bus: z.enum(["threats", "player", "rewards", "weapons", "enemies", "ui"]),
  level: amplitude,
  voices: z.int().check(z.minimum(1), z.maximum(8)),
  gap: seconds,
  send: z.number().check(z.minimum(0), z.maximum(1)),
  duck: z.optional(seconds),
  dur: z.number().check(z.minimum(0.01), z.maximum(10)),
  variants: z.int().check(z.minimum(1), z.maximum(8)),
  pitch: z.optional(z.array(z.number().check(z.minimum(0.1), z.maximum(4)))),
  layers: z.array(layerSchema).check(z.minLength(1), z.maxLength(16)),
});

export type LabOverrides = Partial<Record<SoundId, SoundRecipe>>;

export function isSoundId(id: string): id is SoundId {
  return Object.hasOwn(SOUND_RECIPES, id);
}

/**
 * Прочитать правки. Битая или устаревшая правка одного звука не ломает
 * остальные: она пропускается, звук играет по коду.
 */
export function readLabOverrides(storage: KeyValueStorage | undefined): LabOverrides {
  const raw = storage?.get(LAB_OVERRIDES_KEY) ?? null;
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    console.warn("Правки звуков не читаются, играют звуки из кода:", error);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const result: LabOverrides = {};
  for (const [id, value] of Object.entries(parsed)) {
    const recipe = recipeSchema.safeParse(value);
    if (isSoundId(id) && recipe.success) result[id] = recipe.data as SoundRecipe;
  }
  return result;
}

export function writeLabOverrides(storage: KeyValueStorage | undefined, overrides: LabOverrides): void {
  if (Object.keys(overrides).length === 0) storage?.remove(LAB_OVERRIDES_KEY);
  else storage?.set(LAB_OVERRIDES_KEY, JSON.stringify(overrides));
}
