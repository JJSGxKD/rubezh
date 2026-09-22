import { BUSES, MIX_RULES, SOUND_RECIPES, UI_SOUNDS, type BusGroup, type BusId, type MixRules, type SoundId, type SoundRecipe } from "./recipes";
import { gainNode, renderRecipe, reverbImpulse } from "./synth";

/**
 * Звуковой движок (docs/31-audio-and-haptics.md): шины, правила грани,
 * банк заранее отрисованных буферов. Живёт в отдельном чанке и приходит после
 * первого касания — в первую загрузку оболочки не попадает.
 */

export interface AudioVolumes {
  master: number;
  effects: number;
  ui: number;
}

export interface PlayOptions {
  /** множитель громкости поверх рецепта */
  gain?: number;
  rate?: number;
  pan?: number;
  /** задержка старта, секунды */
  delay?: number;
  variant?: number;
  /** мимо минимального интервала — для лаборатории */
  force?: boolean;
}

interface Voice {
  source: AudioBufferSourceNode;
  amp: GainNode;
  end: number;
}

interface BusNodes {
  input: GainNode;
  duck: GainNode;
  meter: AnalyserNode;
}

export interface LevelReading {
  rms: number;
  peak: number;
}

/**
 * Регулятор 0–100 в громкость. Слух логарифмический: на линейной шкале вся
 * тишина досталась бы последним делениям, а середина звучала бы почти как
 * максимум.
 */
export function volumeCurve(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent)) / 100;
  return clamped ** 1.7;
}

export class AudioEngine {
  readonly recipes: Record<SoundId, SoundRecipe>;
  readonly rules: MixRules = structuredClone(MIX_RULES);
  /** правила грани включены; выключаются в лаборатории — послушать, от чего они спасают */
  /**
   * Правила грани — бюджет шины, плотность и потолок голосов — по умолчанию
   * выключены: на плейтесте они срезали слишком много, и бой звучал глуше,
   * чем есть. Свои `gap` и `voices` у каждого звука остаются всегда
   * (docs/31-audio-and-haptics.md §3).
   */
  rulesEnabled = false;
  /** сколько видов оружия у игрока: каждое тише, когда их много */
  weaponCount = 1;
  /** звуки эффектов молчат — стресс-тест и экран, где звук мешает замеру */
  effectsMuted = false;
  readonly stats = { starts: 0, dropped: 0 };

  /**
   * Посыл в реверб — отдельный на каждую группу и после её регулятора. Реверб
   * один на всех, и если слать в него прямо от голоса, регулятор группы
   * глушит только сухой звук: хвост реверба уходит в компрессор в обход и
   * звучит на нуле.
   */
  private readonly reverbSends: Record<BusGroup, GainNode>;

  private readonly master: GainNode;
  private readonly masterMeter: AnalyserNode;
  private readonly reverbIn: GainNode;
  private readonly groups: Record<BusGroup, GainNode>;
  private readonly buses = {} as Record<BusId, BusNodes>;
  private readonly bank = new Map<SoundId, AudioBuffer[]>();
  private readonly voices = new Map<SoundId, Voice[]>();
  private readonly lastStart = new Map<SoundId, number>();
  private readonly recent = new Map<SoundId, number[]>();

  constructor(
    readonly ctx: AudioContext,
    overrides: Partial<Record<SoundId, SoundRecipe>> = {},
  ) {
    this.recipes = { ...structuredClone(SOUND_RECIPES), ...structuredClone(overrides) } as Record<SoundId, SoundRecipe>;

    // Компрессор держит толпу ровной, лимитер — страховка от перегруза на
    // динамике телефона, которая хрипит раньше наушников.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 10;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.22;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    this.master = gainNode(ctx, 0);
    this.masterMeter = ctx.createAnalyser();
    this.masterMeter.fftSize = 1024;

    const convolver = ctx.createConvolver();
    convolver.buffer = reverbImpulse(ctx, 1.9);
    this.reverbIn = gainNode(ctx, 1);
    this.reverbIn.connect(convolver).connect(gainNode(ctx, 0.45)).connect(compressor);
    this.reverbSends = { effects: gainNode(ctx, 0), ui: gainNode(ctx, 0) };
    for (const send of Object.values(this.reverbSends)) send.connect(this.reverbIn);

    this.groups = { effects: gainNode(ctx, 0), ui: gainNode(ctx, 0) };
    this.groups.effects.connect(compressor);
    this.groups.ui.connect(compressor);

    for (const [id, bus] of Object.entries(BUSES) as [BusId, (typeof BUSES)[BusId]][]) {
      const input = gainNode(ctx, bus.level);
      const duck = gainNode(ctx, 1);
      const meter = ctx.createAnalyser();
      meter.fftSize = 256;
      input.connect(duck).connect(this.groups[bus.group]);
      duck.connect(meter);
      this.buses[id] = { input, duck, meter };
    }
    compressor.connect(limiter).connect(this.master).connect(this.masterMeter).connect(ctx.destination);
  }

  /**
   * Отрисовать банк: сначала интерфейс, затем остальное с передышкой между
   * звуками — рендер идёт в основном потоке, и без пауз он отнял бы кадры у
   * главной на слабом телефоне.
   */
  async renderBank(onProgress?: (done: number, total: number) => void): Promise<void> {
    const order = [...UI_SOUNDS, ...(Object.keys(this.recipes) as SoundId[]).filter((id) => !UI_SOUNDS.includes(id))];
    let done = 0;
    for (const id of order) {
      if (!this.bank.has(id)) await this.rerender(id);
      onProgress?.(++done, order.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Перерисовать звук после правки рецепта — в лаборатории, на ходу. */
  async rerender(id: SoundId): Promise<void> {
    const recipe = this.recipes[id];
    const buffers: AudioBuffer[] = [];
    for (let variant = 0; variant < Math.max(1, recipe.variants); variant++) {
      buffers.push(await renderRecipe(this.ctx.sampleRate, recipe, variant));
    }
    this.bank.set(id, buffers);
  }

  isReady(id: SoundId): boolean {
    return this.bank.has(id);
  }

  play(id: SoundId, options: PlayOptions = {}): boolean {
    if (this.ctx.state !== "running") return false;
    const recipe = this.recipes[id];
    const buffers = this.bank.get(id);
    if (buffers === undefined || buffers.length === 0) return false;
    if (this.effectsMuted && BUSES[recipe.bus].group === "effects") return false;

    const now = this.ctx.currentTime;
    const when = now + (options.delay ?? 0);
    let level = recipe.level * (options.gain ?? 1);

    if (options.force !== true && when - (this.lastStart.get(id) ?? -1) < recipe.gap) return this.drop();

    if (this.rulesEnabled) {
      const budget = this.rules.budgetPerSec[recipe.bus];
      if (budget !== undefined && this.busStartsLastSecond(recipe.bus, now) >= budget) return this.drop();
      // Чем чаще звук, тем тише каждый: двадцать ударов в секунду — шорох, а
      // не двадцать громких ударов.
      if (recipe.bus === "weapons" || recipe.bus === "enemies") {
        const density = Math.max(1, this.recentCount(id, now) / this.rules.densitySoftness);
        level *= Math.max(this.rules.densityFloor, Math.min(1, 1 / Math.sqrt(density)));
      }
      if (recipe.bus === "weapons") level /= Math.sqrt(Math.max(1, this.weaponCount));
      if (this.activeVoices() >= this.rules.globalVoices && BUSES[recipe.bus].priority < 2) return this.drop();
    }

    const live = (this.voices.get(id) ?? []).filter((voice) => voice.end > now);
    const oldest = live[0];
    if (live.length >= recipe.voices && oldest !== undefined) {
      this.fadeOut(oldest, now);
      live.shift();
    }

    const buffer = buffers[options.variant ?? Math.floor(Math.random() * buffers.length)] ?? buffers[0];
    if (buffer === undefined) return this.drop();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;
    const amp = gainNode(this.ctx, level);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = options.pan ?? 0;
    source.connect(amp).connect(panner).connect(this.buses[recipe.bus].input);
    if (recipe.send > 0) panner.connect(gainNode(this.ctx, recipe.send)).connect(this.reverbSends[BUSES[recipe.bus].group]);
    source.start(when);

    live.push({ source, amp, end: when + buffer.duration / (options.rate ?? 1) });
    this.voices.set(id, live);
    this.lastStart.set(id, when);
    this.pushRecent(id, now);
    this.stats.starts++;
    if (this.rulesEnabled && recipe.duck !== undefined) this.duckBelow(recipe.bus, when, recipe.duck);
    return true;
  }

  setVolumes(volumes: AudioVolumes): void {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(volumeCurve(volumes.master), t, 0.05);
    for (const group of Object.keys(this.groups) as BusGroup[]) {
      const level = volumeCurve(volumes[group]);
      this.groups[group].gain.setTargetAtTime(level, t, 0.05);
      this.reverbSends[group].gain.setTargetAtTime(level, t, 0.05);
    }
  }

  activeVoices(): number {
    const now = this.ctx.currentTime;
    let total = 0;
    for (const list of this.voices.values()) for (const voice of list) if (voice.end > now) total++;
    return total;
  }

  masterLevel(): LevelReading {
    return readLevel(this.masterMeter);
  }

  busLevel(bus: BusId): LevelReading {
    return readLevel(this.buses[bus].meter);
  }

  private drop(): false {
    this.stats.dropped++;
    return false;
  }

  private pushRecent(id: SoundId, now: number): void {
    const list = this.recent.get(id) ?? [];
    list.push(now);
    this.recent.set(id, list);
  }

  private recentCount(id: SoundId, now: number): number {
    const list = this.recent.get(id);
    if (list === undefined) return 0;
    while (list.length > 0 && now - (list[0] ?? 0) >= 1) list.shift();
    return list.length;
  }

  private busStartsLastSecond(bus: BusId, now: number): number {
    let total = 0;
    for (const id of this.recent.keys()) if (this.recipes[id].bus === bus) total += this.recentCount(id, now);
    return total;
  }

  /** Угроза или крупное событие приглушает то, что ниже по важности. Интерфейс не трогается. */
  private duckBelow(bus: BusId, when: number, seconds: number): void {
    const priority = BUSES[bus].priority;
    for (const [id, info] of Object.entries(BUSES) as [BusId, (typeof BUSES)[BusId]][]) {
      if (id === bus || id === "ui" || info.priority >= priority) continue;
      const param = this.buses[id].duck.gain;
      param.cancelScheduledValues(when);
      param.setTargetAtTime(this.rules.duckDepth[id] ?? 0.5, when, 0.03);
      param.setTargetAtTime(1, when + seconds, 0.25);
    }
  }

  private fadeOut(voice: Voice, now: number): void {
    voice.amp.gain.cancelScheduledValues(now);
    voice.amp.gain.setValueAtTime(voice.amp.gain.value, now);
    voice.amp.gain.linearRampToValueAtTime(0.0001, now + 0.02);
    voice.source.stop(now + 0.03);
    voice.end = now;
  }
}

function readLevel(analyser: AnalyserNode): LevelReading {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  let sum = 0;
  for (const sample of data) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sum += sample * sample;
  }
  return { rms: Math.sqrt(sum / data.length), peak };
}
