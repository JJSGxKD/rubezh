import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine, type AudioVolumes } from "../src/audio/audio-engine";
import { BUSES, SOUND_RECIPES, type SoundId } from "../src/audio/recipes";

// Маршрутизация шин (docs/31-audio-and-haptics.md §3): регулятор группы на нуле
// обязан глушить группу целиком — вместе с хвостом реверба. Web Audio в Node
// нет, поэтому граф подделан: узлы запоминают связи, параметры — значение, и
// «насколько громко источник слышен на выходе» считается перемножением
// громкостей по всем путям до выхода.

interface FakeParam {
  value: number;
  setTargetAtTime(value: number): FakeParam;
  setValueAtTime(value: number): FakeParam;
  linearRampToValueAtTime(value: number): FakeParam;
  exponentialRampToValueAtTime(value: number): FakeParam;
  cancelScheduledValues(): FakeParam;
  setValueCurveAtTime(): FakeParam;
}

interface FakeNode {
  readonly edges: FakeNode[];
  readonly params: Map<string, FakeParam>;
  [key: string]: unknown;
}

function fakeParam(initial = 1): FakeParam {
  const param: FakeParam = {
    value: initial,
    setTargetAtTime: (value) => ((param.value = value), param),
    setValueAtTime: (value) => ((param.value = value), param),
    linearRampToValueAtTime: (value) => ((param.value = value), param),
    exponentialRampToValueAtTime: (value) => ((param.value = value), param),
    cancelScheduledValues: () => param,
    setValueCurveAtTime: () => param,
  };
  return param;
}

const NODE_METHODS = new Set(["connect", "disconnect", "start", "stop", "getFloatTimeDomainData", "getByteFrequencyData"]);

/** Любой узел: связи — через `connect`, любое незнакомое поле — параметр. */
function fakeNode(): FakeNode {
  const target: FakeNode = { edges: [], params: new Map() };
  return new Proxy(target, {
    get(node, key) {
      if (typeof key !== "string") return undefined;
      if (key === "edges" || key === "params") return node[key];
      if (key === "connect") {
        return (next: FakeNode) => {
          node.edges.push(next);
          return next;
        };
      }
      if (NODE_METHODS.has(key)) return () => undefined;
      if (key in node) return node[key];
      let param = node.params.get(key);
      if (param === undefined) {
        param = fakeParam();
        node.params.set(key, param);
      }
      return param;
    },
    set(node, key, value) {
      if (typeof key === "string") node[key] = value;
      return true;
    },
  });
}

function fakeBuffer(length: number, sampleRate: number): unknown {
  return { length, sampleRate, duration: length / sampleRate, numberOfChannels: 1, getChannelData: () => new Float32Array(length) };
}

function fakeContext(sampleRate = 48_000, length = 1): Record<string, unknown> {
  const destination = fakeNode();
  return new Proxy(
    { currentTime: 0, state: "running", sampleRate, destination },
    {
      get(ctx, key) {
        if (typeof key !== "string") return undefined;
        if (key in ctx) return ctx[key as keyof typeof ctx];
        if (key === "createBuffer") return (_channels: number, bufferLength: number, rate: number) => fakeBuffer(bufferLength, rate);
        if (key === "startRendering") return () => Promise.resolve(fakeBuffer(length, sampleRate));
        if (key.startsWith("create")) return () => fakeNode();
        return () => undefined;
      },
    },
  );
}

/** Громкость, с которой узел слышен на выходе: сумма по путям произведений громкостей узлов. */
function audibility(node: FakeNode, destination: FakeNode, seen = new Set<FakeNode>()): number {
  if (node === destination) return 1;
  if (seen.has(node)) return 0;
  const own = node.params.get("gain")?.value ?? 1;
  let total = 0;
  for (const next of node.edges) total += audibility(next, destination, new Set(seen).add(node));
  return own * total;
}

/** Звук группы с посылом в реверб — ради него баг и был виден: сухой звук глушится, хвост нет. */
function soundWithReverb(group: string): SoundId | undefined {
  const entry = Object.entries(SOUND_RECIPES).find(([, recipe]) => BUSES[recipe.bus].group === group && recipe.send > 0);
  return entry?.[0] as SoundId | undefined;
}

describe("маршрутизация шин", () => {
  let ctx: Record<string, unknown>;
  const created: FakeNode[] = [];

  beforeEach(() => {
    ctx = fakeContext();
    const wrap = ctx.createBufferSource as () => FakeNode;
    ctx.createBufferSource = () => {
      const node = wrap();
      created.push(node);
      return node;
    };
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor(_channels: number, length: number, rate: number) {
          return fakeContext(rate, length);
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    created.length = 0;
  });

  async function playWith(volumes: AudioVolumes, id: SoundId): Promise<number> {
    const engine = new AudioEngine(ctx as unknown as AudioContext);
    engine.setVolumes(volumes);
    await engine.rerender(id);
    created.length = 0;
    expect(engine.play(id, { force: true })).toBe(true);
    const source = created[0];
    if (source === undefined) throw new Error("голос не создан");
    return audibility(source, ctx.destination as FakeNode);
  }

  const loud: AudioVolumes = { master: 60, effects: 85, ui: 90, music: 50 };

  it("у эффектов есть звук с посылом в реверб — иначе проверке не на чем стоять", () => {
    expect(soundWithReverb("effects")).toBeDefined();
  });

  it("регулятор эффектов на нуле глушит эффект вместе с хвостом реверба", async () => {
    const id = soundWithReverb("effects");
    if (id === undefined) throw new Error("нет звука эффектов с ревербом");
    expect(await playWith(loud, id)).toBeGreaterThan(0);
    expect(await playWith({ ...loud, effects: 0 }, id)).toBe(0);
  });

  it("регулятор эффектов не трогает интерфейс, общий — глушит всё", async () => {
    const ui = Object.keys(SOUND_RECIPES).find((id) => BUSES[SOUND_RECIPES[id as SoundId].bus].group === "ui") as SoundId;
    expect(await playWith({ ...loud, effects: 0 }, ui)).toBeGreaterThan(0);
    expect(await playWith({ ...loud, master: 0 }, ui)).toBe(0);
  });
});
