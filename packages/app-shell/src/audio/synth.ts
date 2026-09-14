import type { SoundLayer, SoundRecipe } from "./recipes";

/**
 * Синтез звуков из слоёв рецепта. Звук рисуется один раз в буфер через
 * `OfflineAudioContext` и дальше только проигрывается: собирать граф из
 * осцилляторов на каждый выстрел в толпе — это десятки узлов в кадр на
 * бюджетном Android.
 *
 * Случайность — своя, с зерном: вариант звука одинаков от запуска к запуску,
 * и правка в лаборатории звучит так же у всей команды.
 */

type Ctx = BaseAudioContext;

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100_000) / 100_000;
  };
}

export function gainNode(ctx: Ctx, value = 1): GainNode {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

export function filterNode(ctx: Ctx, type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

/** Огибающая: линейный подъём и экспоненциальный спад — у экспоненты нет щелчка в конце. */
function envelope(param: AudioParam, t: number, attack: number, peak: number, decay: number): void {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noiseSource(ctx: Ctx, seconds: number, seed: number): AudioBufferSourceNode {
  const length = Math.max(1, Math.ceil(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = rng(seed);
  for (let i = 0; i < length; i++) data[i] = random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  return source;
}

function sweep(param: AudioParam, from: number, to: number | undefined, t: number, glide: number): void {
  param.setValueAtTime(from, t);
  if (to !== undefined && to !== from) param.exponentialRampToValueAtTime(Math.max(1, to), t + glide);
}

export function renderLayer(ctx: Ctx, out: AudioNode, layer: SoundLayer, pitch: number, seedOffset: number): void {
  switch (layer.kind) {
    case "tone": {
      const t = layer.t ?? 0;
      const osc = ctx.createOscillator();
      osc.type = layer.wave ?? "sine";
      osc.detune.value = layer.detune ?? 0;
      sweep(osc.frequency, layer.f0 * pitch, layer.f1 === undefined ? undefined : layer.f1 * pitch, t, layer.glide ?? 0.05);
      const amp = gainNode(ctx, 0);
      const attack = layer.attack ?? 0.003;
      envelope(amp.gain, t, attack, layer.peak, layer.decay);
      osc.connect(amp).connect(out);
      osc.start(t);
      osc.stop(t + attack + layer.decay + 0.05);
      return;
    }
    case "hiss": {
      const t = layer.t ?? 0;
      const source = noiseSource(ctx, layer.dur + 0.05, layer.seed + seedOffset);
      const filter = filterNode(ctx, layer.filter ?? "bandpass", layer.f0 * pitch, layer.q ?? 0.8);
      sweep(filter.frequency, layer.f0 * pitch, layer.f1 === undefined ? undefined : layer.f1 * pitch, t, layer.glide ?? layer.dur);
      const amp = gainNode(ctx, 0);
      envelope(amp.gain, t, layer.attack ?? 0.002, layer.peak, layer.decay ?? layer.dur);
      source.connect(filter).connect(amp).connect(out);
      source.start(t);
      return;
    }
    case "bell":
      bell(ctx, out, layer.f * pitch, layer.t ?? 0, layer.peak ?? 0.22, layer.decay ?? 0.35, layer.ratio ?? 3.5, layer.index ?? 1.2);
      return;
    case "swell": {
      const t = layer.t ?? 0;
      const hold = layer.hold ?? 0;
      const end = t + layer.attack + hold + layer.release;
      const amp = gainNode(ctx, 0);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(layer.peak, t + layer.attack);
      amp.gain.setValueAtTime(layer.peak, t + layer.attack + hold);
      amp.gain.exponentialRampToValueAtTime(0.0001, end);
      let input: AudioNode = amp;
      if (layer.filter !== undefined) {
        const spec = layer.filter;
        const filter = filterNode(ctx, spec.type, spec.f0, spec.q ?? 0.7);
        sweep(filter.frequency, spec.f0, spec.f1, t, spec.glide ?? layer.attack);
        filter.connect(amp);
        input = filter;
      }
      amp.connect(out);
      for (const cents of layer.detune ?? [0]) {
        const osc = ctx.createOscillator();
        osc.type = layer.wave ?? "sine";
        osc.detune.value = cents;
        sweep(osc.frequency, layer.f0 * pitch, layer.f1 === undefined ? undefined : layer.f1 * pitch, t, layer.glide ?? layer.attack);
        osc.connect(input);
        osc.start(t);
        osc.stop(end + 0.05);
      }
      return;
    }
  }
}

/** FM-колокольчик: модулятор гаснет быстрее несущей — удар светлый, хвост чистый. */
function bell(ctx: Ctx, out: AudioNode, f: number, t: number, peak: number, decay: number, ratio: number, index: number): void {
  const carrier = ctx.createOscillator();
  const modulator = ctx.createOscillator();
  const depth = gainNode(ctx, 0);
  carrier.frequency.value = f;
  modulator.frequency.value = f * ratio;
  depth.gain.setValueAtTime(f * index, t);
  depth.gain.exponentialRampToValueAtTime(1, t + decay * 0.4);
  modulator.connect(depth).connect(carrier.frequency);
  const amp = gainNode(ctx, 0);
  envelope(amp.gain, t, 0.002, peak, decay);
  carrier.connect(amp).connect(out);
  carrier.start(t);
  modulator.start(t);
  carrier.stop(t + decay + 0.1);
  modulator.stop(t + decay + 0.1);
  renderLayer(ctx, out, { kind: "tone", f0: f * 2, t, peak: peak * 0.18, decay: decay * 0.5 }, 1, 0);
}

/** Отрисовать один вариант звука в буфер. */
export async function renderRecipe(sampleRate: number, recipe: SoundRecipe, variant: number): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(recipe.dur * sampleRate)), sampleRate);
  const out = gainNode(offline, 1);
  out.connect(offline.destination);
  const pitch = recipe.pitch?.[variant] ?? 1;
  for (const layer of recipe.layers) renderLayer(offline, out, layer, pitch, variant * 3);
  return offline.startRendering();
}

/**
 * Щипок струны по Карплусу — Стронгу: шумовой импульс в затухающей петле.
 * Считается напрямую в массив: у DelayNode петля не короче 128 отсчётов, и
 * высокие ноты так не сыграть. Звучит как гусли.
 */
export function pluck(
  sampleRate: number,
  frequency: number,
  seconds: number,
  brightness: number,
  decay: number,
  seed: number,
): Float32Array<ArrayBuffer> {
  const length = Math.ceil(sampleRate * seconds);
  const out = new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT));
  const period = Math.max(2, Math.round(sampleRate / frequency));
  const loop = new Float32Array(period);
  const random = rng(seed);
  let previous = 0;
  for (let i = 0; i < period; i++) {
    previous += brightness * (random() * 2 - 1 - previous);
    loop[i] = previous;
  }
  let index = 0;
  for (let n = 0; n < length; n++) {
    const next = (index + 1) % period;
    const sample = loop[index] ?? 0;
    loop[index] = decay * 0.5 * (sample + (loop[next] ?? 0));
    out[n] = sample * (n < 40 ? n / 40 : 1);
    index = next;
  }
  return out;
}

/** Импульс реверберации: затухающий шум, по каналу на ухо. */
export function reverbImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const random = rng(900 + channel);
    for (let i = 0; i < length; i++) {
      const fade = 1 - i / length;
      data[i] = (random() * 2 - 1) * fade * fade * fade;
    }
  }
  return buffer;
}
