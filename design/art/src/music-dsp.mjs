/**
 * Звуковые кирпичи музыки (design/art/src/music.mjs): осцилляторы, фильтры,
 * гусли по Карплусу — Стронгу, бубен, хор и реверберация. Всё считается в
 * Node без Web Audio: так рендер повторяется бит в бит на любой машине, а
 * случайность идёт только из генератора с зерном.
 */

export const RATE = 48_000;
const TAU = Math.PI * 2;

/** Генератор с зерном (mulberry32): одна и та же пьеса при каждом запуске. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** Стереодорожка заданной длины. */
export function track(seconds) {
  const n = Math.ceil(seconds * RATE);
  return [new Float32Array(n), new Float32Array(n)];
}

/** Положить моно-звук в стерео со сдвигом, громкостью и панорамой (равная мощность). */
export function place(dst, mono, atSec, gain = 1, pan = 0) {
  const start = Math.round(atSec * RATE);
  const angle = ((pan + 1) / 4) * Math.PI;
  const gl = Math.cos(angle) * gain;
  const gr = Math.sin(angle) * gain;
  const [l, r] = dst;
  const end = Math.min(mono.length, l.length - start);
  for (let i = Math.max(0, -start); i < end; i++) {
    l[start + i] += mono[i] * gl;
    r[start + i] += mono[i] * gr;
  }
}

/** Сложить стерео в стерео с громкостью. */
export function mixInto(dst, src, gain = 1) {
  for (let c = 0; c < 2; c++) {
    const d = dst[c];
    const s = src[c];
    const n = Math.min(d.length, s.length);
    for (let i = 0; i < n; i++) d[i] += s[i] * gain;
  }
}

/** Огибающая: атака, спад к уровню удержания, удержание до `hold`, затухание `release`. */
export function envelope(n, { attack = 0.005, decay = 0.1, sustain = 1, hold, release = 0.1 }) {
  const out = new Float32Array(n);
  const a = Math.max(1, Math.round(attack * RATE));
  const d = Math.max(1, Math.round(decay * RATE));
  const h = Math.round((hold ?? n / RATE) * RATE);
  const r = Math.max(1, Math.round(release * RATE));
  for (let i = 0; i < n; i++) {
    let v;
    if (i < a) v = i / a;
    else if (i < a + d) v = 1 - (1 - sustain) * ((i - a) / d);
    else v = sustain;
    if (i >= h) v *= Math.max(0, 1 - (i - h) / r);
    // Мягкий изгиб атаки: линейная атака у медленных голосов щёлкает в начале.
    out[i] = v * v * (3 - 2 * v);
  }
  return out;
}

/** Пила с полиBLEP: без алиасинга на высоких нотах хора и меди. */
export function saw(n, hz, phase = 0, detuneCents = 0, vibrato = null) {
  const out = new Float32Array(n);
  const base = hz * 2 ** (detuneCents / 1200);
  let p = phase;
  for (let i = 0; i < n; i++) {
    const f = vibrato ? base * (1 + vibrato.depth * Math.sin((TAU * vibrato.rate * i) / RATE + vibrato.phase)) : base;
    const dt = f / RATE;
    let v = 2 * p - 1;
    if (p < dt) {
      const t = p / dt;
      v -= t + t - t * t - 1;
    } else if (p > 1 - dt) {
      const t = (p - 1) / dt;
      v -= t * t + t + t + 1;
    }
    out[i] = v;
    p += dt;
    if (p >= 1) p -= 1;
  }
  return out;
}

export function sine(n, hz, phase = 0) {
  const out = new Float32Array(n);
  const w = (TAU * hz) / RATE;
  for (let i = 0; i < n; i++) out[i] = Math.sin(phase + w * i);
  return out;
}

/** Синус со скольжением частоты — тело барабана. */
export function sweep(n, f0, f1, glideSec) {
  const out = new Float32Array(n);
  let ph = 0;
  const g = Math.max(1, glideSec * RATE);
  for (let i = 0; i < n; i++) {
    const f = f1 + (f0 - f1) * Math.exp(-i / g);
    ph += (TAU * f) / RATE;
    out[i] = Math.sin(ph);
  }
  return out;
}

export function noise(n, rand) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Биквадратный фильтр RBJ; `cutoff` — число или функция от доли длины (для огибающей фильтра). */
export function biquad(input, type, cutoff, q = 0.707) {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;
  const update = (fc) => {
    const w = (TAU * Math.min(fc, RATE * 0.45)) / RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    if (type === "lowpass") {
      b0 = (1 - cos) / 2 / a0;
      b1 = (1 - cos) / a0;
      b2 = b0;
    } else if (type === "highpass") {
      b0 = (1 + cos) / 2 / a0;
      b1 = -(1 + cos) / a0;
      b2 = b0;
    } else {
      b0 = alpha / a0;
      b1 = 0;
      b2 = -alpha / a0;
    }
    a1 = (-2 * cos) / a0;
    a2 = (1 - alpha) / a0;
  };
  const dynamic = typeof cutoff === "function";
  update(dynamic ? cutoff(0) : cutoff);
  for (let i = 0; i < input.length; i++) {
    if (dynamic && (i & 31) === 0) update(cutoff(i / input.length));
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

export function multiply(a, b) {
  for (let i = 0; i < a.length; i++) a[i] *= b[i];
  return a;
}

export function add(a, b, gain = 1) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) a[i] += b[i] * gain;
  return a;
}

/**
 * Струна гуслей по Карплусу — Стронгу: возбуждение — отфильтрованный шум
 * (яркость — щипок ногтём или подушечкой), затухание — усреднение в петле.
 * Короткий «щелчок» щипка добавляет атаку, которой у чистой петли нет.
 */
export function gusli(hz, seconds, rand, { brightness = 0.6, decay = 0.9975, pluckPos = 0.18 } = {}) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const period = RATE / hz;
  // Усреднение двух соседних отсчётов в петле само задерживает на полсэмпла: без поправки струна строит ниже.
  const delay = period - 0.5;
  const first = Math.ceil(period) + 2;
  let excite = noise(first, rand);
  excite = biquad(excite, "lowpass", 800 + brightness * 7000, 0.6);
  // Точка щипка: гребенчатый вырез убирает гармоники, которых нет у струны, тронутой у края.
  const comb = Math.max(1, Math.round(period * pluckPos));
  for (let i = 0; i < Math.min(first, n); i++) out[i] = excite[i] - (i >= comb ? excite[i - comb] * 0.9 : 0);
  for (let i = first; i < n; i++) {
    const at = i - delay;
    const i0 = Math.floor(at);
    const fr = at - i0;
    const a = out[i0] * (1 - fr) + out[i0 + 1] * fr;
    const b = out[i0 - 1] * (1 - fr) + out[i0] * fr;
    out[i] = decay * 0.5 * (a + b);
  }
  const click = biquad(noise(Math.round(0.004 * RATE), rand), "highpass", 3000);
  for (let i = 0; i < click.length; i++) out[i] += click[i] * 0.25 * (1 - i / click.length) * brightness;
  // Мягкий конец: струна не обрывается на границе буфера.
  const fade = Math.round(0.05 * RATE);
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

/** Бубен: низ кожи (скольжение 110 → 62 Гц) и звон тарелочек. */
export function frameDrum(rand, { low = 1, jingle = 0.3, dur = 0.5, pitch = 1 } = {}) {
  const n = Math.round(dur * RATE);
  const body = multiply(sweep(n, 110 * pitch, 62 * pitch, 0.05), envelope(n, { attack: 0.001, decay: dur * 0.9, sustain: 0, release: 0.01 }));
  const skin = multiply(biquad(noise(n, rand), "bandpass", 260 * pitch, 0.9), envelope(n, { attack: 0.001, decay: 0.08, sustain: 0, release: 0.01 }));
  // Звон — полосой 6,5–10 кГц: выше лишь песок, который утомляет и съедает биты кодека.
  const zils = multiply(biquad(biquad(noise(n, rand), "highpass", 6500, 0.8), "lowpass", 10_000, 0.7), envelope(n, { attack: 0.002, decay: 0.22, sustain: 0, release: 0.01 }));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = body[i] * 0.9 * low + skin[i] * 0.55 * low + zils[i] * jingle;
  return out;
}

/**
 * Большой барабан босса: удар 95 → 48 Гц, второй тон кожи и хлопок. Низ ниже
 * 60 Гц динамик телефона не играет — удар слышен по обертонам насыщения и
 * хлопку, поэтому они громче, чем было бы для наушников.
 */
export function bigDrum(rand, { dur = 1.2, gain = 1 } = {}) {
  const n = Math.round(dur * RATE);
  const shape = envelope(n, { attack: 0.002, decay: dur * 0.85, sustain: 0, release: 0.02 });
  const body = multiply(sweep(n, 95, 48, 0.1), shape);
  const second = multiply(sweep(n, 160, 96, 0.08), envelope(n, { attack: 0.002, decay: dur * 0.4, sustain: 0, release: 0.02 }));
  const slap = multiply(biquad(noise(n, rand), "bandpass", 320, 0.8), envelope(n, { attack: 0.001, decay: 0.09, sustain: 0, release: 0.01 }));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.tanh((body[i] * 1.3 + second[i] * 0.35 + slap[i] * 0.6) * 1.8) * gain * 0.8;
  return out;
}

/** Шейкер — короткий светлый шорох. */
export function shaker(rand, gain = 1) {
  const n = Math.round(0.07 * RATE);
  return multiply(biquad(biquad(noise(n, rand), "highpass", 5200, 0.7), "lowpass", 10_000, 0.7), envelope(n, { attack: 0.012, decay: 0.05, sustain: 0, release: 0.01 })).map((v) => v * gain);
}

/** Форманты гласных «а» и «о» — хор без слов. */
const VOWELS = {
  a: [
    [730, 1, 10],
    [1090, 0.5, 12],
    [2440, 0.18, 14],
  ],
  o: [
    [570, 1, 10],
    [840, 0.45, 12],
    [2410, 0.12, 14],
  ],
  u: [
    [300, 1, 9],
    [870, 0.3, 11],
    [2240, 0.08, 13],
  ],
};

/** Голос хора: три пилы с расстройкой и медленным вибрато через форманты гласной. */
export function choirVoice(hz, seconds, vowel, rand, { attack = 1.6, release = 2.2 } = {}) {
  const n = Math.round(seconds * RATE);
  const src = new Float32Array(n);
  for (const cents of [-9, 0, 8]) {
    add(src, saw(n, hz, rand(), cents, { rate: 4.6 + rand(), depth: 0.0035, phase: rand() * TAU }), 0.33);
  }
  const out = new Float32Array(n);
  for (const [f, g, q] of VOWELS[vowel]) add(out, biquad(src, "bandpass", f, q), g);
  // Нота у форманты гласной звенит на десяток децибел громче соседних: каждый голос выравнивается по среднеквадратичному.
  let sum = 0;
  for (const v of out) sum += v * v;
  const gain = 0.07 / Math.sqrt(sum / n || 1);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return multiply(out, envelope(n, { attack, decay: 0.5, sustain: 1, hold: seconds - release, release }));
}

/** Бурдон: квинта и октава, фильтр медленно дышит — как колёсная лира издалека. */
export function drone(midiRoot, seconds, rand, { breath = 0.07, cutoff = 520 } = {}) {
  const n = Math.round(seconds * RATE);
  const src = new Float32Array(n);
  for (const [m, g] of [
    [midiRoot, 0.55],
    [midiRoot + 7, 0.35],
    [midiRoot + 12, 0.22],
  ]) {
    // Расстройка в два цента: биения медленнее пяти секунд дышат, а не качают бас.
    add(src, saw(n, midiHz(m), rand(), -1), g);
    add(src, saw(n, midiHz(m), rand(), 1.2), g);
  }
  const phase = rand() * TAU;
  return biquad(src, "lowpass", (x) => cutoff * (1 + 0.35 * Math.sin(TAU * x * seconds * breath + phase)), 0.9);
}

/**
 * Реверберация Freeverb (Jezar): восемь гребенчатых и четыре всепропускающих
 * фильтра на канал. Алгоритмическая, а не свёртка: свёртка минуты музыки с
 * трёхсекундным откликом без БПФ заняла бы минуты.
 */
export function freeverb(input, { room = 0.86, damp = 0.35, wet = 0.3, width = 1 } = {}) {
  const scale = RATE / 44_100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(d * scale));
  const allpasses = [556, 441, 341, 225].map((d) => Math.round(d * scale));
  const spread = Math.round(23 * scale);
  const out = [new Float32Array(input[0].length), new Float32Array(input[0].length)];
  for (let c = 0; c < 2; c++) {
    const src = input[0].map((v, i) => (v + input[1][i]) * 0.5);
    const lines = combs.map((d) => ({ buf: new Float32Array(d + c * spread), idx: 0, store: 0 }));
    const aps = allpasses.map((d) => ({ buf: new Float32Array(d + c * spread), idx: 0 }));
    const o = out[c];
    for (let i = 0; i < src.length; i++) {
      const x = src[i] * 0.015;
      let s = 0;
      for (const line of lines) {
        const y = line.buf[line.idx];
        line.store = y * (1 - damp) + line.store * damp;
        line.buf[line.idx] = x + line.store * room;
        line.idx = (line.idx + 1) % line.buf.length;
        s += y;
      }
      for (const ap of aps) {
        const b = ap.buf[ap.idx];
        ap.buf[ap.idx] = s + b * 0.5;
        s = b - s;
        ap.idx = (ap.idx + 1) % ap.buf.length;
      }
      o[i] = s;
    }
  }
  const wet1 = wet * (width / 2 + 0.5);
  const wet2 = wet * ((1 - width) / 2);
  const l = out[0].map((v, i) => v * wet1 + out[1][i] * wet2);
  const r = out[1].map((v, i) => v * wet1 + out[0][i] * wet2);
  return [l, r];
}

/** Свернуть хвост за концом круга в его начало: круг звучит без шва, с отзвуком прошлого прохода. */
export function foldLoop(stereo, loopSec) {
  const n = Math.round(loopSec * RATE);
  return stereo.map((ch) => {
    const out = ch.slice(0, n);
    for (let i = n; i < ch.length; i++) out[i - n] += ch[i];
    return out;
  });
}

export function peak(stereo) {
  let p = 0;
  for (const ch of stereo) for (const v of ch) p = Math.max(p, Math.abs(v));
  return p;
}

export function rms(stereo) {
  let s = 0;
  let n = 0;
  for (const ch of stereo) for (const v of ch) {
    s += v * v;
    n++;
  }
  return Math.sqrt(s / n);
}

export function scale(stereo, gain) {
  for (const ch of stereo) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  return stereo;
}

/** WAV 16 бит со сдвигом-дизерингом: в кодер идёт PCM, не float. */
export function wav(stereo, rand) {
  const n = stereo[0].length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      const v = Math.max(-1, Math.min(1, stereo[c][i])) * 32767 + (rand() - rand());
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 44 + i * 4 + c * 2);
    }
  }
  return buf;
}
