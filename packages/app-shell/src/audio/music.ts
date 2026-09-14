import type { AudioEngine } from "./audio-engine";
import type { SoundLayer } from "./recipes";
import { filterNode, gainNode, pluck, renderRecipe } from "./synth";

/**
 * Адаптивная музыка (docs/31-audio-and-haptics.md): бурдон, гусли, бубен, хор
 * в ре дорийском. Слои входят и уходят только на границе такта, мелодия
 * собирается из мотивов, а не бродит случайно.
 *
 * Музыка не рисуется целиком заранее: каждые 25 мс планируются ноты на
 * ближайшие 120 мс — так смена слоя или сцены слышна в пределах такта, а не
 * после конца трека.
 */

/** Ре дорийский от ре малой октавы: номер ступени → частота. */
const SCALE = [
  146.83, 164.81, 174.61, 196, 220, 246.94, 261.63, 293.66, 329.63, 349.23, 392, 440, 493.88, 523.25, 587.33, 659.25,
  698.46, 783.99, 880,
];

/** Аккорды — ступени от ре. */
const CHORDS = { Dm: [0, 2, 4], C: [6, 8, 10], F: [2, 4, 6], G: [3, 5, 7], Am: [4, 6, 8] } as const;
type ChordName = keyof typeof CHORDS;

export type MusicContext = "lobby" | "run";

const CONTEXTS: Record<MusicContext, { bpm: number; progression: ChordName[] }> = {
  lobby: { bpm: 72, progression: ["Dm", "Dm", "G", "G", "Dm", "Dm", "C", "C"] },
  run: { bpm: 92, progression: ["Dm", "C", "F", "C", "Dm", "C", "G", "Am"] },
};

/** Мотивы: [ступень от основного тона аккорда, шестнадцатая в такте]. */
const MOTIFS: readonly (readonly [number, number])[][] = [
  [[0, 0], [2, 4], [4, 8], [3, 12]],
  [[4, 0], [3, 3], [2, 6], [0, 8], [1, 12]],
  [[0, 0], [1, 2], [2, 4], [4, 6], [5, 8], [4, 12]],
  [[7, 0], [5, 4], [4, 8], [2, 10], [4, 12]],
];

/** Сколько напряжения нужно для каждого следующего слоя; с запасом вниз, чтобы слой не мигал на пороге. */
const LAYER_THRESHOLDS = [0.15, 0.35, 0.55, 0.78];
const LAYER_HYSTERESIS = 0.08;
const LOOKAHEAD_SEC = 0.12;
const TICK_MS = 25;

export type MusicScene = "play" | "pause" | "choice";

export interface MusicState {
  running: boolean;
  context: MusicContext;
  layers: number;
  boost: boolean;
}

export class Music {
  private readonly plucks: AudioBuffer[] = [];
  private drum: AudioBuffer | null = null;
  private ghost: AudioBuffer | null = null;
  private shaker: AudioBuffer | null = null;
  private tom: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private context: MusicContext = "lobby";
  private nextTime = 0;
  private step = 0;
  private intensity = 0.2;
  private layers = 1;
  private boostBars = 0;
  private motifSeed = 7;
  private live: GainNode[] = [];
  private readonly listeners = new Set<(state: MusicState) => void>();

  constructor(private readonly engine: AudioEngine) {}

  async prepare(): Promise<void> {
    const ctx = this.engine.ctx;
    const rate = ctx.sampleRate;
    SCALE.forEach((frequency, index) => {
      const data = pluck(rate, frequency, 1.8, 0.55, 0.9965, 300 + index);
      const buffer = ctx.createBuffer(1, data.length, rate);
      buffer.copyToChannel(data, 0);
      this.plucks.push(buffer);
    });
    this.drum = await this.renderHit(0.45, [
      { kind: "tone", f0: 118, f1: 62, glide: 0.12, peak: 0.6, decay: 0.34 },
      { kind: "hiss", dur: 0.2, seed: 401, f0: 220, q: 0.8, peak: 0.32, decay: 0.16 },
      { kind: "hiss", t: 0.01, dur: 0.16, seed: 402, filter: "highpass", f0: 6500, peak: 0.05, decay: 0.14 },
    ]);
    this.ghost = await this.renderHit(0.2, [
      { kind: "tone", f0: 150, f1: 90, glide: 0.06, peak: 0.25, decay: 0.12 },
      { kind: "hiss", dur: 0.12, seed: 403, filter: "highpass", f0: 6000, peak: 0.06, decay: 0.1 },
    ]);
    this.shaker = await this.renderHit(0.08, [
      { kind: "hiss", dur: 0.07, seed: 404, filter: "highpass", f0: 5200, attack: 0.012, peak: 0.12, decay: 0.05 },
    ]);
    this.tom = await this.renderHit(0.6, [{ kind: "tone", f0: 84, f1: 48, glide: 0.25, peak: 0.55, decay: 0.5 }]);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get currentContext(): MusicContext {
    return this.context;
  }

  onChange(listener: (state: MusicState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(context: MusicContext): void {
    if (this.running && this.context === context) return;
    this.stop(0.05);
    this.context = context;
    this.nextTime = this.engine.ctx.currentTime + 0.1;
    this.step = 0;
    this.motifSeed = Math.floor(Math.random() * 1000);
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.emit();
  }

  stop(fadeSec = 0.6): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const t = this.engine.ctx.currentTime;
    for (const node of this.live) {
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(0.0001, t, fadeSec / 4);
    }
    this.live = [];
    this.emit();
  }

  /** Напряжение боя 0…1: сколько слоёв играет. */
  setIntensity(value: number): void {
    this.intensity = Math.max(0, Math.min(1, value));
  }

  /** Мало здоровья — будто уши заложило: музыка глохнет, сердце слышно. */
  setHealth(ratio: number, scene: MusicScene): void {
    if (scene !== "play") return;
    const cutoff = ratio < 0.3 ? 450 + ratio * 3000 : 16_000;
    this.engine.musicFilter.frequency.setTargetAtTime(cutoff, this.engine.ctx.currentTime, 0.3);
  }

  /** Пауза и выбор улучшения: музыка отходит на второй план, но не рвётся. */
  setScene(scene: MusicScene): void {
    const t = this.engine.ctx.currentTime;
    const cutoff = scene === "pause" ? 700 : scene === "choice" ? 1400 : 16_000;
    const level = scene === "pause" ? 0.5 : scene === "choice" ? 0.45 : 1;
    this.engine.musicFilter.frequency.setTargetAtTime(cutoff, t, 0.2);
    this.engine.musicInput.gain.setTargetAtTime(level, t, 0.2);
  }

  /** Элита: следующие восемь тактов бой звучит в полную силу. */
  eliteBoost(): void {
    this.boostBars = 8;
  }

  /** Поражение: музыка уходит, гусли спускаются вниз. */
  defeat(): void {
    this.stop(1.5);
    const t = this.engine.ctx.currentTime;
    [14, 13, 11, 9, 7].forEach((degree, index) => this.pluckNote(t + 0.3 + index * 0.32, degree, 0.5, 0));
  }

  private renderHit(seconds: number, layers: SoundLayer[]): Promise<AudioBuffer> {
    const recipe = { bus: "music" as const, level: 1, voices: 1, gap: 0, send: 0, dur: seconds, variants: 1, layers };
    return renderRecipe(this.engine.ctx.sampleRate, recipe, 0);
  }

  private schedule(): void {
    const ctx = this.engine.ctx;
    const stepSec = 60 / CONTEXTS[this.context].bpm / 4;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_SEC) {
      this.playStep(this.nextTime, this.step, stepSec);
      this.nextTime += stepSec;
      this.step++;
    }
  }

  private targetLayers(): number {
    if (this.context === "lobby") return 1;
    if (this.boostBars > 0) return 4;
    let count = 0;
    for (const threshold of LAYER_THRESHOLDS) {
      if (this.intensity >= threshold - (this.layers > count ? LAYER_HYSTERESIS : 0)) count++;
    }
    return count;
  }

  private playStep(t: number, step: number, stepSec: number): void {
    const inBar = step % 16;
    const bar = Math.floor(step / 16);
    const def = CONTEXTS[this.context];
    const chord = CHORDS[def.progression[bar % def.progression.length] ?? "Dm"];
    const phraseBar = bar % 8;
    const lobby = this.context === "lobby";

    if (inBar === 0) {
      this.layers = this.targetLayers();
      if (this.boostBars > 0) this.boostBars--;
      this.emit();
      if (!lobby || bar % 2 === 0) this.pad(t, chord, stepSec * (lobby ? 32 : 16));
      if (bar % 4 === 0) this.drone(t, stepSec * 64);
      if (this.layers >= 4) this.choir(t, chord, stepSec * 16);
      if (bar % 8 === 0) this.motifSeed = (this.motifSeed * 9301 + 49297) % 233280;
    }

    if (lobby) {
      if (inBar % 4 === 0) this.pluckNote(t, (chord[(inBar / 4) % 3] ?? 0) + 7, 0.24, -0.2);
      if (phraseBar % 2 === 1) this.motif(t, inBar, chord, 0.3, 14);
      return;
    }

    if (inBar % 4 === 0) this.pluckNote(t, (chord[(inBar / 4) % 3] ?? 0) + 7, 0.28, -0.25);
    if (this.layers >= 2) {
      if (inBar === 0 || inBar === 8) this.sample(this.drum, t, 0.55, 0);
      if (inBar === 6 || inBar === 14) this.sample(this.ghost, t, 0.4, 0.1);
      if (this.layers >= 3 && inBar === 10) this.sample(this.drum, t, 0.35, 0);
    }
    if (this.layers >= 3) {
      if (inBar % 2 === 0) this.pluckNote(t, (chord[[0, 2, 1, 2][(inBar / 2) % 4] ?? 0] ?? 0) + 7, 0.2, 0.25);
      else this.sample(this.shaker, t, 0.5, 0.35);
    }
    if (this.layers >= 4) {
      if (phraseBar >= 4) this.motif(t, inBar, chord, 0.34, 14);
      if (phraseBar === 7 && inBar >= 12) this.sample(this.drum, t, 0.3 + (inBar - 12) * 0.08, 0);
      if (phraseBar === 3 && inBar === 12) this.sample(this.tom, t, 0.5, -0.1);
    }
  }

  private motif(t: number, inBar: number, chord: readonly number[], gain: number, octave: number): void {
    const phrase = MOTIFS[this.motifSeed % MOTIFS.length] ?? [];
    for (const [degree, at] of phrase) {
      if (at === inBar) this.pluckNote(t, Math.min(SCALE.length - 1, (chord[0] ?? 0) + degree + octave - 7), gain, 0);
    }
  }

  private sample(buffer: AudioBuffer | null, t: number, gain: number, pan: number): void {
    if (buffer === null) return;
    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    source.connect(gainNode(ctx, gain)).connect(panner).connect(this.engine.musicInput);
    source.start(t);
  }

  private pluckNote(t: number, degree: number, gain: number, pan: number): void {
    const buffer = this.plucks[Math.max(0, Math.min(this.plucks.length - 1, degree))];
    if (buffer === undefined) return;
    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    source.connect(gainNode(ctx, gain)).connect(panner).connect(this.engine.musicInput);
    panner.connect(gainNode(ctx, 0.25)).connect(this.engine.reverbIn);
    source.start(t);
  }

  private track(node: GainNode): GainNode {
    this.live.push(node);
    if (this.live.length > 40) this.live = this.live.slice(-40);
    return node;
  }

  private pad(t: number, chord: readonly number[], seconds: number): void {
    const ctx = this.engine.ctx;
    const lowpass = filterNode(ctx, "lowpass", 380 + this.intensity * 1600, 0.4);
    const amp = this.track(gainNode(ctx, 0));
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.035, t + Math.min(1, seconds * 0.3));
    amp.gain.setValueAtTime(0.035, t + seconds * 0.8);
    amp.gain.linearRampToValueAtTime(0.0001, t + seconds + 0.2);
    lowpass.connect(amp).connect(this.engine.musicInput);
    amp.connect(this.engine.reverbIn);
    for (const degree of chord) {
      for (const cents of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = (SCALE[degree] ?? 146.83) / 2;
        osc.detune.value = cents;
        osc.connect(lowpass);
        osc.start(t);
        osc.stop(t + seconds + 0.3);
      }
    }
  }

  /** Бурдон на ре и ля — как у колёсной лиры: держит лад под всем остальным. */
  private drone(t: number, seconds: number): void {
    const ctx = this.engine.ctx;
    const lowpass = filterNode(ctx, "lowpass", 420, 0.5);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    lfo.connect(gainNode(ctx, 140)).connect(lowpass.frequency);
    const amp = this.track(gainNode(ctx, 0));
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.05, t + 1.5);
    amp.gain.setValueAtTime(0.05, t + seconds - 1);
    amp.gain.linearRampToValueAtTime(0.0001, t + seconds + 0.5);
    lowpass.connect(amp).connect(this.engine.musicInput);
    for (const frequency of [73.42, 110]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = frequency;
      osc.connect(lowpass);
      osc.start(t);
      osc.stop(t + seconds + 0.6);
    }
    lfo.start(t);
    lfo.stop(t + seconds + 0.6);
  }

  /** Хор «у»: пила через две форманты и лёгкое вибрато. */
  private choir(t: number, chord: readonly number[], seconds: number): void {
    const ctx = this.engine.ctx;
    const amp = this.track(gainNode(ctx, 0));
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.028, t + 0.6);
    amp.gain.setValueAtTime(0.028, t + seconds - 0.4);
    amp.gain.linearRampToValueAtTime(0.0001, t + seconds + 0.3);
    const low = filterNode(ctx, "bandpass", 420, 5);
    const high = filterNode(ctx, "bandpass", 850, 6);
    low.connect(amp);
    high.connect(gainNode(ctx, 0.5)).connect(amp);
    amp.connect(this.engine.musicInput);
    amp.connect(gainNode(ctx, 0.6)).connect(this.engine.reverbIn);
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 5.2;
    const depth = gainNode(ctx, 3.5);
    vibrato.connect(depth);
    for (const degree of chord) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = SCALE[degree] ?? 146.83;
      depth.connect(osc.frequency);
      osc.connect(low);
      osc.connect(high);
      osc.start(t);
      osc.stop(t + seconds + 0.4);
    }
    vibrato.start(t);
    vibrato.stop(t + seconds + 0.4);
  }

  private emit(): void {
    const state: MusicState = { running: this.running, context: this.context, layers: this.layers, boost: this.boostBars > 0 };
    for (const listener of this.listeners) listener(state);
  }
}
