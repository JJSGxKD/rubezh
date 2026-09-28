import type { RunCues } from "@bh/core-game";
import { AudioEngine, type AudioVolumes, type PlayOptions } from "./audio-engine";
import type { SoundId, SoundRecipe } from "./recipes";

/**
 * Режиссёр звука (docs/31-audio-and-haptics.md): что звучит на сигналы
 * забега, какая музыка на каком экране и где проходит грань.
 *
 * Грань — не только правила движка. Здесь решается, сколько звуков вообще
 * просить: на пачку убийств — не больше трёх хлопков, у взрыва вдали — треть
 * громкости, у «Грозы» звучит сам удар молнии, а не срабатывание оружия.
 */

export type SoundScene = "lobby" | "run" | "pause" | "choice" | "finished" | "silent";
export type RunSoundEvent = "levelUp" | "choose" | "death" | "abandon" | "record";
export type UiSound = "tap" | "select" | "primary" | "back" | "toggleOn" | "toggleOff" | "sheetOpen" | "sheetClose" | "reward" | "error";

export interface HudSound {
  hpRatio: number;
  weapons: number;
}

const UI_SOUND_IDS: Record<UiSound, SoundId> = {
  tap: "uiTap",
  select: "uiSelect",
  primary: "uiPress",
  back: "uiBack",
  toggleOn: "uiToggleOn",
  toggleOff: "uiToggleOff",
  sheetOpen: "uiSheetOpen",
  sheetClose: "uiSheetClose",
  reward: "uiReward",
  error: "uiError",
};

/** Оружие со своим звуком срабатывания. «Гроза» звучит ударом молнии — сигналом `strikes`. */
const WEAPON_SOUNDS: Partial<Record<string, SoundId>> = {
  spark: "spark",
  knife: "knife",
  wardstone: "wardstone",
  hearth: "hearth",
};

const LOW_HP_RATIO = 0.3;
/** Сердце бьётся чаще, чем ниже здоровье: от раза в 0,9 с до раза в 0,55 с. */
const HEARTBEAT_SLOW_SEC = 0.9;
const HEARTBEAT_FAST_SEC = 0.55;
/**
 * Сбор опыта — лесенкой (`35-stage4-plan.md`, Р57): каждый следующий
 * кристалл серии — ступенью выше по пентатонике в пределах октавы. Наверху
 * лесенка не упирается в одну ноту, а чередует две верхние ступени — долгая
 * серия не превращается в один и тот же звук на кулдауне. Пауза в серии —
 * лесенка снова снизу.
 */
const GEM_LADDER = [0, 2, 4, 7, 9, 12] as const;
const GEM_STREAK_RESET_SEC = 0.8;
/** Крупный сбор за раз — магнит, горсть с элиты — арпеджио до стольких нот. */
const GEM_BURST_MAX = 6;
const GEM_BURST_STEP_SEC = 0.04;

/**
 * Ноты сбора опыта за один опрос: сколько — по объёму опыта (логарифмом,
 * чтобы магнит на сотню кристаллов не стал сотней звуков), какие — по
 * ступени серии.
 */
export function gemNotes(xp: number, streak: number): { rate: number; delay: number }[] {
  if (xp <= 0) return [];
  const count = Math.min(GEM_BURST_MAX, 1 + Math.floor(Math.log2(xp)));
  const top = GEM_LADDER.length - 1;
  return Array.from({ length: count }, (_, i) => {
    const step = streak + i;
    const index = step <= top ? step : top - 1 + ((step - top + 1) % 2);
    return { rate: 2 ** ((GEM_LADDER[index] ?? 0) / 12), delay: Math.round(i * GEM_BURST_STEP_SEC * 1000) / 1000 };
  });
}

export interface SoundRequest {
  id: SoundId;
  options: PlayOptions;
}

/**
 * Какие звуки просить на пачку сигналов. Порядок — по важности: если правила
 * грани упрутся в потолок голосов, резаться будут последние.
 */
export function planCueSounds(cues: RunCues, gemStreak: number): SoundRequest[] {
  const plan: SoundRequest[] = [];
  const add = (id: SoundId, options: PlayOptions = {}): void => {
    plan.push({ id, options });
  };

  // Атаки врагов не звучат — фитиль, рывок, выстрел, взрыв подрывника
  // (`35-stage4-plan.md`, Р57): угрозу читают глазами по телеграфу, а ухо
  // слышит результат — попадание по игроку. Появление элиты остаётся: это
  // предупреждение, а не атака.
  if (cues.playerHit > 0) add("hurt");
  if (cues.dynamite > 0) add("dynamite");
  if (cues.eliteSpawns > 0) add("eliteHorn");
  if (cues.eliteKills > 0) add("eliteDown");
  if (cues.heal > 0) add("heal");
  if (cues.magnet > 0) add("magnet");
  if (cues.strikes > 0) add("storm");

  for (const [id, count] of Object.entries(cues.weapons)) {
    const sound = WEAPON_SOUNDS[id];
    if (sound !== undefined && count > 0) add(sound);
  }

  // Пачка убийств — до трёх хлопков вразбивку: сотня одновременных
  // хлопков звучит одним щелчком, а три с разносом — толпой.
  const pops = Math.min(3, cues.kills - cues.eliteKills);
  for (let i = 0; i < pops; i++) add("popSmall", { delay: i * 0.035, pan: (i - 1) * 0.3 });

  for (const note of gemNotes(cues.xp, gemStreak)) add("gem", note.delay === 0 ? { rate: note.rate } : { rate: note.rate, delay: note.delay });
  return plan;
}

export class SoundDirector {
  readonly engine: AudioEngine;
  private scene: SoundScene = "lobby";
  private hpRatio = 1;
  private heartbeatAt = 0;
  private gemStreak = 0;
  private lastGemAt = 0;

  constructor(ctx: AudioContext, overrides: Partial<Record<SoundId, SoundRecipe>>) {
    this.engine = new AudioEngine(ctx, overrides);
  }

  async prepare(): Promise<void> {
    await this.engine.renderBank();
    // Сцена могла смениться, пока рисовался банк: движок узнаёт текущую.
    this.applyScene();
  }

  setVolumes(volumes: AudioVolumes): void {
    this.engine.setVolumes(volumes);
  }

  ui(kind: UiSound): void {
    this.engine.play(UI_SOUND_IDS[kind]);
  }

  setScene(scene: SoundScene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    this.applyScene();
  }

  setHud(hud: HudSound): void {
    this.engine.weaponCount = Math.max(1, hud.weapons);
    this.hpRatio = hud.hpRatio;
    this.heartbeat();
  }

  runEvent(event: RunSoundEvent): void {
    if (event === "levelUp") this.engine.play("levelUp");
    else if (event === "choose") this.engine.play("choose");
    else if (event === "record") this.engine.play("record");
    else if (event === "death") this.engine.play("defeat");
  }

  cues(cues: RunCues): void {
    if (this.scene !== "run") return;
    const { engine } = this;
    const now = engine.ctx.currentTime;
    if (cues.xp > 0 && now - this.lastGemAt >= GEM_STREAK_RESET_SEC) this.gemStreak = 0;
    for (const request of planCueSounds(cues, this.gemStreak)) engine.play(request.id, request.options);
    if (cues.xp > 0) {
      this.gemStreak += gemNotes(cues.xp, this.gemStreak).length;
      this.lastGemAt = now;
    }
  }

  suspend(): Promise<void> {
    return this.engine.ctx.suspend();
  }

  resume(): Promise<void> {
    return this.engine.ctx.resume();
  }

  private applyScene(): void {
    this.engine.effectsMuted = this.scene === "silent";
  }

  private heartbeat(): void {
    if (this.scene !== "run" || this.hpRatio <= 0 || this.hpRatio > LOW_HP_RATIO) return;
    const now = this.engine.ctx.currentTime;
    const interval = HEARTBEAT_FAST_SEC + (HEARTBEAT_SLOW_SEC - HEARTBEAT_FAST_SEC) * (this.hpRatio / LOW_HP_RATIO);
    if (now - this.heartbeatAt < interval) return;
    this.heartbeatAt = now;
    this.engine.play("heartbeat");
  }
}
