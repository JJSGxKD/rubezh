import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import { AudioEngine } from "../src/audio/audio-engine";
import { DEFAULT_VOLUMES } from "../src/audio";
import { BUSES } from "../src/audio/recipes";
import tracks from "../src/audio/music/tracks.json";
import { MusicPlayer, pickFormat, planMusic, type MusicFormat, type MusicTrack } from "../src/audio/music";
import { useSettings } from "../src/state/settings";
import { initShell } from "../src/state/shell";

// Музыка (docs/31-audio-and-haptics.md §5, T-0234): какой трек и с каким
// затуханием звучит на какой сцене. Web Audio в Node нет, поэтому контекст
// подделан: параметры помнят последнее плавное изменение, источники — откуда
// и когда стартовали.

interface Ramp {
  value: number;
  /** через сколько секунд от момента вызова значение достигнуто */
  seconds: number;
}

class FakeParam {
  value: number;
  ramp: Ramp | null = null;
  constructor(
    initial: number,
    private readonly clock: () => number,
  ) {
    this.value = initial;
  }
  cancelScheduledValues(): this {
    return this;
  }
  setValueAtTime(value: number): this {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, at: number): this {
    this.ramp = { value, seconds: Math.round((at - this.clock()) * 1000) / 1000 };
    return this;
  }
  setTargetAtTime(value: number): this {
    this.value = value;
    return this;
  }
}

class FakeGain {
  readonly gain: FakeParam;
  next: FakeGain | null = null;
  constructor(clock: () => number) {
    this.gain = new FakeParam(1, clock);
  }
  connect(node: FakeGain): FakeGain {
    this.next = node;
    return node;
  }
}

class FakeSource {
  buffer: { track: MusicTrack; duration: number } | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  started: { when: number; offset: number } | null = null;
  stoppedAt: number | null = null;
  out: FakeGain | null = null;
  connect(node: FakeGain): FakeGain {
    this.out = node;
    return node;
  }
  start(when: number, offset: number): void {
    this.started = { when, offset };
  }
  stop(when: number): void {
    this.stoppedAt = when;
  }
}

class FakeContext {
  currentTime = 0;
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  createGain(): FakeGain {
    const node = new FakeGain(() => this.currentTime);
    this.gains.push(node);
    return node;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

/** Плеер на подделке: `requests` — что просили загрузить, `failing` — какие треки не загружаются. */
function harness(options: { format?: MusicFormat; failing?: MusicTrack[] } = {}) {
  const ctx = new FakeContext();
  const output = new FakeGain(() => ctx.currentTime);
  const requests: { track: MusicTrack; format: MusicFormat }[] = [];
  const failing = new Set(options.failing ?? []);
  const player = new MusicPlayer(ctx as unknown as AudioContext, output as unknown as AudioNode, {
    format: options.format ?? "ogg",
    load: async (track, format) => {
      requests.push({ track, format });
      if (failing.has(track)) throw new Error("нет файла");
      return { track, duration: tracks[track].seconds } as unknown as AudioBuffer;
    },
  });
  /** Загрузки и их продолжения — микрозадачи: даём им завершиться. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const live = (track: MusicTrack) => ctx.sources.filter((source) => source.buffer?.track === track && source.started !== null);
  /** Узел громкости трека — тот, куда подключён его источник. */
  const gainOf = (source: FakeSource): FakeParam => (source.out as FakeGain).gain;
  /** Узел общего приглушения — следующий за громкостью трека. */
  const dim = (): FakeParam => ((ctx.sources[0]?.out as FakeGain).next as FakeGain).gain;
  return { ctx, output, player, requests, settle, live, gainOf, dim };
}

describe("план музыки по сцене", () => {
  it("меню — lobby; забег — run; босс на поле — и boss поверх run", () => {
    expect(planMusic("lobby", false).gains).toEqual({ lobby: 1, run: 0, boss: 0 });
    expect(planMusic("run", false).gains).toEqual({ lobby: 0, run: 1, boss: 0 });
    expect(planMusic("run", true).gains).toEqual({ lobby: 0, run: 1, boss: 1 });
  });

  it("пауза и выбор улучшения приглушают до 35 %, а не глушат; босс остаётся", () => {
    for (const scene of ["pause", "choice"] as const) {
      const plan = planMusic(scene, true);
      expect(plan.dim).toBe(0.35);
      expect(plan.gains).toEqual({ lobby: 0, run: 1, boss: 1 });
    }
    expect(planMusic("run", false).dim).toBe(1);
  });

  it("смерть и итоги — run и boss затухают, lobby входит только после закрытия итогов", () => {
    const plan = planMusic("finished", true);
    expect(plan.gains).toEqual({ lobby: 0, run: 0, boss: 0 });
    expect(plan.fadeSec.run).toBe(2);
    expect(plan.fadeSec.boss).toBe(2);
    expect(planMusic("lobby", false).fadeSec.lobby).toBe(1.5);
  });

  it("стресс-тест — тишина", () => {
    expect(planMusic("silent", true).gains).toEqual({ lobby: 0, run: 0, boss: 0 });
  });
});

describe("воспроизведение", () => {
  it("меню: грузится только lobby, играет кругом по длине из tracks.json и входит на полную", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("lobby");
    await h.settle();

    expect(h.requests).toEqual([{ track: "lobby", format: "ogg" }]);
    const [lobby] = h.live("lobby");
    expect(lobby?.loop).toBe(true);
    expect(lobby?.loopStart).toBe(0);
    expect(lobby?.loopEnd).toBe(tracks.lobby.seconds);
    expect(lobby?.started?.offset).toBe(0);
    expect(lobby === undefined ? null : h.gainOf(lobby).ramp?.value).toBe(1);
  });

  it("лобби → забег: перекрёстное затухание 1,5 с; lobby гаснет и останавливается, run входит с начала круга", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("lobby");
    await h.settle();
    h.ctx.currentTime = 20;
    h.player.setScene("run");
    await h.settle();

    expect(h.requests.map((request) => request.track)).toEqual(["lobby", "run"]);
    const [lobby] = h.live("lobby");
    const [run] = h.live("run");
    expect(lobby === undefined ? null : h.gainOf(lobby).ramp).toEqual({ value: 0, seconds: 1.5 });
    expect(lobby?.stoppedAt).toBe(21.5);
    expect(run?.started?.offset).toBe(0);
    expect(run === undefined ? null : h.gainOf(run).ramp).toEqual({ value: 1, seconds: 1.5 });
  });

  it("босс появился — boss стартует с позиции run; ушёл — затухает 2 с и останавливается", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    h.ctx.currentTime = 10;
    h.player.setBoss(true);
    await h.settle();

    const [boss] = h.live("boss");
    expect(h.requests.map((request) => request.track)).toEqual(["run", "boss"]);
    expect(boss?.started?.offset).toBe(10);
    expect(boss?.loopEnd).toBe(tracks.boss.seconds);
    expect(boss === undefined ? null : h.gainOf(boss).ramp).toEqual({ value: 1, seconds: 2 });

    h.ctx.currentTime = 30;
    h.player.setBoss(false);
    expect(boss === undefined ? null : h.gainOf(boss).ramp).toEqual({ value: 0, seconds: 2 });
    expect(boss?.stoppedAt).toBe(32);
    // run при этом играет дальше.
    const [run] = h.live("run");
    expect(run?.stoppedAt).toBeNull();
  });

  it("позиция босса считается по кругу: на второй минуте — остаток от длины круга", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    h.ctx.currentTime = 70;
    h.player.setBoss(true);
    await h.settle();

    expect(h.live("boss")[0]?.started?.offset).toBeCloseTo(70 - tracks.run.seconds, 6);
  });

  it("босс вернулся, пока прошлый затухал, — новый источник с той же позиции, а не обрыв", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    h.player.setBoss(true);
    await h.settle();
    h.ctx.currentTime = 5;
    h.player.setBoss(false);
    h.ctx.currentTime = 6;
    h.player.setBoss(true);

    const bosses = h.live("boss");
    expect(bosses).toHaveLength(2);
    expect(bosses[1]?.started?.offset).toBe(6);
    expect(bosses[1]?.stoppedAt).toBeNull();
  });

  it("пауза — приглушение до 35 % за 0,3 с; снятие паузы возвращает громкость", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    h.player.setScene("pause");
    expect(h.dim().ramp).toEqual({ value: 0.35, seconds: 0.3 });
    h.player.setScene("run");
    expect(h.dim().ramp).toEqual({ value: 1, seconds: 0.3 });
  });

  it("смерть: run затухает 2 с; закрыли итоги — lobby входит", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    h.ctx.currentTime = 100;
    h.player.setScene("finished");
    const [run] = h.live("run");
    expect(run === undefined ? null : h.gainOf(run).ramp).toEqual({ value: 0, seconds: 2 });
    expect(run?.stoppedAt).toBe(102);
    expect(h.live("lobby")).toHaveLength(0);

    h.ctx.currentTime = 110;
    h.player.setScene("lobby");
    await h.settle();
    const [lobby] = h.live("lobby");
    expect(lobby === undefined ? null : h.gainOf(lobby).ramp).toEqual({ value: 1, seconds: 1.5 });
  });

  it("новый забег после итогов начинается с начала круга, а не с середины", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    h.ctx.currentTime = 100;
    h.player.setScene("lobby");
    h.ctx.currentTime = 200;
    h.player.setScene("run");
    await h.settle();

    expect(h.live("run").at(-1)?.started?.offset).toBe(0);
  });
});

describe("громкость и загрузка", () => {
  it("громкость 0 — треки не грузятся", async () => {
    const h = harness();
    h.player.setVolume(0);
    h.player.setScene("lobby");
    h.player.setScene("run");
    h.player.setBoss(true);
    await h.settle();

    expect(h.requests).toEqual([]);
    expect(h.ctx.sources).toHaveLength(0);
  });

  it("регулятор ушёл на ноль посреди игры — музыка останавливается, а вернулся — играет с нужной сцены", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    const [run] = h.live("run");
    h.ctx.currentTime = 50;
    h.player.setVolume(0);
    expect(run?.stoppedAt).not.toBeNull();
    expect(h.player.state().enabled).toBe(false);

    h.player.setVolume(30);
    await h.settle();
    // Уже загруженный трек второй раз не качается.
    expect(h.requests).toHaveLength(1);
    expect(h.live("run").at(-1)?.stoppedAt).toBeNull();
  });

  it("треки грузятся по одному по мере нужды: босс — только когда появился", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    await h.settle();
    expect(h.requests.map((request) => request.track)).toEqual(["run"]);
    h.player.setBoss(true);
    await h.settle();
    expect(h.requests.map((request) => request.track)).toEqual(["run", "boss"]);
  });

  it("ошибка загрузки — тишина без исключения; повторного запроса за сессию нет, остальные треки играют", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness({ failing: ["lobby"] });
    h.player.setVolume(40);
    expect(() => h.player.setScene("lobby")).not.toThrow();
    await h.settle();
    h.player.setScene("run");
    h.player.setScene("lobby");
    h.player.setScene("lobby");
    await h.settle();

    expect(h.requests.filter((request) => request.track === "lobby")).toHaveLength(1);
    expect(h.live("lobby")).toHaveLength(0);
    expect(h.player.state().failed).toEqual(["lobby"]);
    expect(h.live("run")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("формат: OGG там, где Opus поддержан, иначе m4a", () => {
    expect(pickFormat((type) => (type.includes("opus") ? "probably" : ""))).toBe("ogg");
    expect(pickFormat(() => "")).toBe("m4a");
    const h = harness({ format: "m4a" });
    h.player.setVolume(40);
    h.player.setScene("lobby");
    expect(h.requests).toEqual([{ track: "lobby", format: "m4a" }]);
  });

  it("состояние для лаборатории: какие треки звучат", async () => {
    const h = harness();
    h.player.setVolume(40);
    h.player.setScene("run");
    h.player.setBoss(true);
    await h.settle();
    expect(h.player.state()).toMatchObject({ enabled: true, playing: ["run", "boss"], failed: [] });
  });
});

function memoryStorage(values: Record<string, string>): KeyValueStorage {
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

function shellWith(stored: Record<string, string>): void {
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: memoryStorage(stored),
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "web" },
  });
}

describe("регулятор «Музыка» в настройках", () => {
  it("умолчание — 40, и оно в общем наборе громкостей", () => {
    expect(DEFAULT_VOLUMES).toEqual({ master: 60, effects: 85, ui: 90, music: 40 });
  });

  it("настройки без поля читаются с 40; остальные громкости и вибрация не теряются", () => {
    shellWith({ "bh.settings.v1": JSON.stringify({ screenMode: "fullscreen", volumes: { master: 40, effects: 70, ui: 50 }, haptics: false }) });
    useSettings.getState().hydrate("normal");
    expect(useSettings.getState().volumes).toEqual({ master: 40, effects: 70, ui: 50, music: 40 });
    expect(useSettings.getState().haptics).toBe(false);
  });

  it("прежние настройки без набора громкостей — с 40, выключенный звук не заигрывает", () => {
    shellWith({ "bh.settings.v1": JSON.stringify({ screenMode: null, sound: false, haptics: true }) });
    useSettings.getState().hydrate("normal");
    expect(useSettings.getState().volumes).toEqual({ ...DEFAULT_VOLUMES, effects: 0, ui: 0, music: 40 });
  });

  it("сохранённая громкость музыки читается как есть, включая ноль", () => {
    shellWith({ "bh.settings.v1": JSON.stringify({ screenMode: null, volumes: { master: 60, effects: 85, ui: 90, music: 0 }, haptics: true }) });
    useSettings.getState().hydrate("normal");
    expect(useSettings.getState().volumes.music).toBe(0);
  });

  it("регулятор двигается, ограничивается 0–100 и пишет одно событие на решение", () => {
    const events: { name: string; props: unknown }[] = [];
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: memoryStorage({}),
      analytics: (name: string, props: unknown) => {
        events.push({ name, props });
      },
      build: { version: "test", contentHash: "", platform: "web" },
    } as unknown as Parameters<typeof initShell>[0]);
    useSettings.getState().hydrate("normal");
    useSettings.getState().setVolume("music", 140);
    expect(useSettings.getState().volumes.music).toBe(100);
    useSettings.getState().setVolume("music", 25);
    useSettings.getState().commitVolume("music");
    expect(events.filter((event) => event.name === "settings_changed" && JSON.stringify(event.props).includes("music"))).toHaveLength(1);
  });
});

describe("шина music в движке", () => {
  it("уровень на 6–8 дБ ниже эффектов, своя группа, правила грани эффектов её не касаются", () => {
    expect(BUSES.music).toMatchObject({ level: 0.45, group: "music" });
    // 0,45 ≈ −6,9 дБ относительно полного уровня шины.
    expect(20 * Math.log10(BUSES.music.level)).toBeGreaterThan(-8);
    expect(20 * Math.log10(BUSES.music.level)).toBeLessThan(-6);
  });

  describe("граф", () => {
    interface Node {
      edges: Node[];
      gain: { value: number; [key: string]: unknown };
      [key: string]: unknown;
    }
    const nodes: Node[] = [];

    function node(): Node {
      const made: Node = {
        edges: [],
        gain: {
          value: 1,
          setTargetAtTime(value: number) {
            made.gain.value = value;
            return made.gain;
          },
          setValueAtTime: () => made.gain,
          cancelScheduledValues: () => made.gain,
          linearRampToValueAtTime: () => made.gain,
        },
        connect(next: Node) {
          made.edges.push(next);
          return next;
        },
        frequency: { value: 0 },
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
      };
      nodes.push(made);
      return made;
    }

    /** Насколько громко узел слышен на выходе: сумма по путям произведений громкостей. */
    function audibility(from: Node, destination: Node, seen = new Set<Node>()): number {
      if (from === destination) return 1;
      if (seen.has(from)) return 0;
      let total = 0;
      for (const next of from.edges) total += audibility(next, destination, new Set(seen).add(from));
      return from.gain.value * total;
    }

    beforeEach(() => {
      nodes.length = 0;
    });
    afterEach(() => {
      nodes.length = 0;
    });

    it("регулятор «Музыка» на нуле глушит шину целиком, а у реверба музыки нет вовсе", () => {
      const destination = node();
      const ctx = {
        currentTime: 0,
        sampleRate: 48_000,
        state: "running",
        destination,
        createGain: node,
        createDynamicsCompressor: node,
        createAnalyser: node,
        createConvolver: node,
        createBuffer: (_channels: number, length: number, rate: number) => ({ length, sampleRate: rate, copyToChannel: () => undefined, getChannelData: () => new Float32Array(length) }),
      };
      const engine = new AudioEngine(ctx as unknown as AudioContext);
      const input = engine.musicInput as unknown as Node;

      engine.setVolumes({ master: 100, effects: 100, ui: 100, music: 100 });
      expect(audibility(input, destination as Node)).toBeGreaterThan(0);

      engine.setVolumes({ master: 100, effects: 100, ui: 100, music: 0 });
      expect(audibility(input, destination as Node)).toBe(0);

      // Эффекты при этом не затронуты.
      expect(DEFAULT_VOLUMES.music).toBe(40);
    });
  });
});
