import type { RunCues } from "@bh/core-game";
import { AudioEngine, type AudioVolumes, type PlayOptions } from "./audio-engine";
import { Music } from "./music";
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
  enemies: number;
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

/** Толпа в сотню живых врагов — полное напряжение музыки. */
const FULL_INTENSITY_ENEMIES = 110;
const LOW_HP_RATIO = 0.3;
/** Сердце бьётся чаще, чем ниже здоровье: от раза в 0,9 с до раза в 0,55 с. */
const HEARTBEAT_SLOW_SEC = 0.9;
const HEARTBEAT_FAST_SEC = 0.55;
/** Кристаллы подряд звучат выше — серия слышна как серия. */
const GEM_STREAK_STEP = 0.035;
const GEM_STREAK_MAX = 8;
const GEM_STREAK_RESET_SEC = 0.6;

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

  if (cues.playerHit > 0) add("hurt");
  if (cues.dynamite > 0) add("dynamite");
  // Взрыв вдали тише: он не опасен, но толпа подрывников должна быть слышна.
  if (cues.explosionsNear > 0) add("blast");
  else if (cues.explosions > 0) add("blast", { gain: 0.35 });
  if (cues.eliteSpawns > 0) add("eliteHorn");
  if (cues.eliteKills > 0) add("eliteDown");
  if (cues.fuses > 0) add("fuseTick");
  if (cues.dashWarns > 0) add("dashWarn");
  if (cues.dashes > 0) add("dashGo");
  if (cues.enemyShots > 0) add("enemyShot");
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

  if (cues.xp > 0) add("gem", { rate: 1 + Math.min(GEM_STREAK_MAX, gemStreak) * GEM_STREAK_STEP });
  return plan;
}

export class SoundDirector {
  readonly engine: AudioEngine;
  readonly music: Music;
  private scene: SoundScene = "lobby";
  private hpRatio = 1;
  private heartbeatAt = 0;
  private gemStreak = 0;
  private lastGemAt = 0;

  constructor(ctx: AudioContext, overrides: Partial<Record<SoundId, SoundRecipe>>) {
    this.engine = new AudioEngine(ctx, overrides);
    this.music = new Music(this.engine);
  }

  async prepare(): Promise<void> {
    await this.engine.renderBank();
    await this.music.prepare();
    // Сцена могла смениться, пока рисовался банк: музыка стартует с текущей.
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
    this.music.setIntensity(hud.enemies / FULL_INTENSITY_ENEMIES);
    this.hpRatio = hud.hpRatio;
    this.music.setHealth(this.hpRatio, this.scene === "run" ? "play" : "pause");
    this.heartbeat();
  }

  runEvent(event: RunSoundEvent): void {
    if (event === "levelUp") this.engine.play("levelUp");
    else if (event === "choose") this.engine.play("choose");
    else if (event === "record") this.engine.play("record");
    else if (event === "death") {
      this.engine.play("defeat");
      this.music.defeat();
    }
  }

  cues(cues: RunCues): void {
    if (this.scene !== "run") return;
    const { engine } = this;
    const now = engine.ctx.currentTime;
    if (cues.eliteSpawns > 0) this.music.eliteBoost();
    if (cues.xp > 0) {
      this.gemStreak = now - this.lastGemAt < GEM_STREAK_RESET_SEC ? Math.min(GEM_STREAK_MAX, this.gemStreak + 1) : 0;
      this.lastGemAt = now;
    }
    for (const request of planCueSounds(cues, this.gemStreak)) engine.play(request.id, request.options);
  }

  suspend(): Promise<void> {
    return this.engine.ctx.suspend();
  }

  resume(): Promise<void> {
    return this.engine.ctx.resume();
  }

  private applyScene(): void {
    const { music, engine } = this;
    engine.effectsMuted = this.scene === "silent";
    if (this.scene === "silent" || this.scene === "finished") {
      if (this.scene === "silent") music.stop(0.4);
      return;
    }
    const context = this.scene === "lobby" ? "lobby" : "run";
    if (!music.running || music.currentContext !== context) music.start(context);
    music.setScene(this.scene === "pause" ? "pause" : this.scene === "choice" ? "choice" : "play");
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
