import tracks from "./music/tracks.json";
import type { SoundScene } from "./sound-director";

/**
 * Воспроизведение музыки (docs/31-audio-and-haptics.md §5, Р147, Р180): три
 * готовых трека — `lobby`, `run` и `boss` — кругом, переходы по сцене звука и по
 * боссу на поле. Сами треки собраны кодом в `design/art/src/music.mjs`; здесь
 * только решение, какой из них сейчас слышен и как быстро.
 *
 * Приходит отдельным чанком после первого касания, как и остальной звук:
 * в первую загрузку оболочки не попадает. Файлы треков — ассеты сборки,
 * в JS-бюджет не входят.
 */

export type MusicTrack = "lobby" | "run" | "boss";
export type MusicFormat = "ogg" | "m4a";

/** Перекрёстное затухание между `lobby` и `run`. */
const SWITCH_FADE_SEC = 1.5;
/** Вход и выход слоя босса, затухание `run` на смерти и итогах. */
const LONG_FADE_SEC = 2;
/** Пауза — не тишина: музыка отходит на второй план. */
const DIM_LEVEL = 0.35;
const DIM_FADE_SEC = 0.3;
/** Сцена без музыки (стресс-тест, регулятор на нуле): гасим быстро, но без щелчка. */
const CUT_FADE_SEC = 0.2;
const LOAD_TIMEOUT_MS = 30_000;

export interface MusicPlan {
  /** целевая громкость каждого трека, 0…1 */
  gains: Record<MusicTrack, number>;
  /** за сколько секунд трек доходит до цели */
  fadeSec: Record<MusicTrack, number>;
  /** общее приглушение поверх всех треков */
  dim: number;
}

/**
 * Что звучит на сцене. Выбор улучшения — та же остановка мира, что пауза, и
 * приглушается так же. Итоги: `run` и `boss` гаснут, а `lobby` входит уже после
 * закрытия итогов — на сцене «лобби», а не поверх экрана итогов.
 */
export function planMusic(scene: SoundScene, boss: boolean): MusicPlan {
  const inRun = scene === "run" || scene === "pause" || scene === "choice";
  const gains: Record<MusicTrack, number> = { lobby: scene === "lobby" ? 1 : 0, run: inRun ? 1 : 0, boss: inRun && boss ? 1 : 0 };
  const cut = scene === "silent";
  const fadeSec: Record<MusicTrack, number> = cut
    ? { lobby: CUT_FADE_SEC, run: CUT_FADE_SEC, boss: CUT_FADE_SEC }
    : { lobby: SWITCH_FADE_SEC, run: scene === "finished" ? LONG_FADE_SEC : SWITCH_FADE_SEC, boss: LONG_FADE_SEC };
  return { gains, fadeSec, dim: scene === "pause" || scene === "choice" ? DIM_LEVEL : 1 };
}

/** OGG Opus там, где браузер его играет, иначе AAC в `.m4a` (Safari). */
export function pickFormat(canPlay: (type: string) => string): MusicFormat {
  return canPlay('audio/ogg; codecs="opus"') !== "" ? "ogg" : "m4a";
}

/**
 * Адреса файлов — литералами внутри `new URL(…, import.meta.url)`: так Vite
 * видит их, кладёт в сборку с хэшем в имени и подставляет настоящий адрес.
 */
const URLS: Record<MusicFormat, Record<MusicTrack, string>> = {
  ogg: {
    lobby: new URL("./music/lobby.ogg", import.meta.url).href,
    run: new URL("./music/run.ogg", import.meta.url).href,
    boss: new URL("./music/boss.ogg", import.meta.url).href,
  },
  m4a: {
    lobby: new URL("./music/lobby.m4a", import.meta.url).href,
    run: new URL("./music/run.m4a", import.meta.url).href,
    boss: new URL("./music/boss.m4a", import.meta.url).href,
  },
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${String(ms)} мс`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type MusicLoader = (track: MusicTrack, format: MusicFormat) => Promise<AudioBuffer>;

function fetchLoader(ctx: AudioContext): MusicLoader {
  return async (track, format) => {
    const response = await withTimeout(fetch(URLS[format][track]), LOAD_TIMEOUT_MS, `загрузка трека ${track}`);
    if (!response.ok) throw new Error(`трек ${track}: HTTP ${String(response.status)}`);
    const data = await withTimeout(response.arrayBuffer(), LOAD_TIMEOUT_MS, `чтение трека ${track}`);
    return await withTimeout(ctx.decodeAudioData(data), LOAD_TIMEOUT_MS, `разбор трека ${track}`);
  };
}

function canPlayType(type: string): string {
  return typeof document === "undefined" ? "" : document.createElement("audio").canPlayType(type);
}

export interface MusicOptions {
  /** как достать буфер трека; в тестах — подделка без сети */
  load?: MusicLoader;
  format?: MusicFormat;
}

export interface MusicState {
  enabled: boolean;
  /** треки, которые сейчас звучат или входят */
  playing: MusicTrack[];
  loaded: MusicTrack[];
  /** не загрузились — до конца сессии не запрашиваются */
  failed: MusicTrack[];
}

interface Active {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** момент, на который запланирована остановка; `null` — трек играет */
  stopAt: number | null;
  /** к какой громкости идёт трек: повторный запрос той же цели затухание не перезапускает */
  target: number;
}

const ORDER: readonly MusicTrack[] = ["lobby", "run", "boss"];

/** Плавное изменение параметра: от текущего значения к цели за `seconds`. */
function rampTo(param: AudioParam, target: number, seconds: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + seconds);
}

export class MusicPlayer {
  private readonly load: MusicLoader;
  private readonly format: MusicFormat;
  private readonly dim: GainNode;
  private readonly buffers = new Map<MusicTrack, AudioBuffer>();
  private readonly loading = new Map<MusicTrack, Promise<void>>();
  private readonly failed = new Set<MusicTrack>();
  private readonly active = new Map<MusicTrack, Active[]>();
  /**
   * Начало круга для `run` и `boss`: один отсчёт на двоих, поэтому слой босса,
   * заведённый на любой секунде, попадает в такт с пульсом. `null` — оба молчат,
   * следующий из них начнётся с начала круга.
   */
  private origin: number | null = null;
  /** `null` — сцену ещё не сообщили: до первой музыки нет */
  private scene: SoundScene | null = null;
  private boss = false;
  private enabled = false;
  private dimTarget = 1;

  constructor(
    private readonly ctx: AudioContext,
    private readonly output: AudioNode,
    options: MusicOptions = {},
  ) {
    this.load = options.load ?? fetchLoader(ctx);
    this.format = options.format ?? pickFormat(canPlayType);
    this.dim = ctx.createGain();
    this.dim.connect(output);
  }

  /** Регулятор «Музыка»: на нуле треки не грузятся, а играющие останавливаются. */
  setVolume(percent: number): void {
    const enabled = percent > 0;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.apply();
  }

  setScene(scene: SoundScene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    this.apply();
  }

  /** Босс на поле — по снимку HUD. */
  setBoss(present: boolean): void {
    if (present === this.boss) return;
    this.boss = present;
    this.apply();
  }

  state(): MusicState {
    const playing = ORDER.filter((track) => (this.active.get(track) ?? []).some((voice) => voice.stopAt === null));
    return { enabled: this.enabled, playing, loaded: ORDER.filter((track) => this.buffers.has(track)), failed: ORDER.filter((track) => this.failed.has(track)) };
  }

  private apply(): void {
    const now = this.ctx.currentTime;
    const plan = planMusic(this.enabled && this.scene !== null ? this.scene : "silent", this.boss);
    if (plan.dim !== this.dimTarget) {
      this.dimTarget = plan.dim;
      rampTo(this.dim.gain, plan.dim, DIM_FADE_SEC, now);
    }
    for (const track of ORDER) {
      this.prune(track, now);
      if (plan.gains[track] > 0) this.fadeIn(track, plan.fadeSec[track], now);
      else this.fadeOut(track, plan.fadeSec[track], now);
    }
  }

  private fadeIn(track: MusicTrack, seconds: number, now: number): void {
    const buffer = this.buffers.get(track);
    if (buffer === undefined) {
      this.ensureLoaded(track);
      return;
    }
    const playing = (this.active.get(track) ?? []).find((voice) => voice.stopAt === null);
    const voice = playing ?? this.start(track, buffer, now);
    if (voice.target === 1) return;
    voice.target = 1;
    rampTo(voice.gain.gain, 1, seconds, now);
  }

  private fadeOut(track: MusicTrack, seconds: number, now: number): void {
    const voices = this.active.get(track);
    if (voices === undefined) return;
    for (const voice of voices) {
      if (voice.stopAt !== null) continue;
      rampTo(voice.gain.gain, 0, seconds, now);
      voice.source.stop(now + seconds);
      voice.stopAt = now + seconds;
      voice.target = 0;
    }
    this.releaseOrigin();
  }

  /** Отзвучавшие источники из списка убираются: за долгую сессию их набралось бы сколько угодно. */
  private prune(track: MusicTrack, now: number): void {
    const voices = this.active.get(track);
    if (voices === undefined) return;
    const left = voices.filter((voice) => voice.stopAt === null || voice.stopAt > now);
    if (left.length !== voices.length) this.active.set(track, left);
  }

  /** Не загружен — один запрос на трек; не загрузился — больше не просим до конца сессии. */
  private ensureLoaded(track: MusicTrack): void {
    if (this.failed.has(track) || this.loading.has(track)) return;
    const request = this.load(track, this.format).then(
      (buffer) => {
        this.buffers.set(track, buffer);
        this.loading.delete(track);
        this.apply();
      },
      (error: unknown) => {
        this.loading.delete(track);
        this.failed.add(track);
        // Без музыки игра остаётся игрой; повторять не будем — один раз за сессию.
        console.warn(`Музыка: трек ${track} не загрузился:`, error);
      },
    );
    this.loading.set(track, request);
  }

  private start(track: MusicTrack, buffer: AudioBuffer, now: number): Active {
    const seconds = tracks[track].seconds;
    const offset = track === "lobby" ? 0 : this.runOffset(now, seconds);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // Круг — по длине из tracks.json, а не по длине буфера: декодер вправе
    // добавить или срезать пару отсчётов на краю, и шов поплыл бы.
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = seconds;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.dim);
    source.start(now, offset);
    const voice: Active = { source, gain, stopAt: null, target: 0 };
    this.active.set(track, [...(this.active.get(track) ?? []), voice]);
    return voice;
  }

  private runOffset(now: number, seconds: number): number {
    const sibling = (["run", "boss"] as const).some((track) => (this.active.get(track) ?? []).some((voice) => voice.stopAt === null));
    if (!sibling || this.origin === null) {
      this.origin = now;
      return 0;
    }
    return (now - this.origin) % seconds;
  }

  private releaseOrigin(): void {
    const playing = (["run", "boss"] as const).some((track) => (this.active.get(track) ?? []).some((voice) => voice.stopAt === null));
    if (!playing) this.origin = null;
  }
}
