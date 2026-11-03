/**
 * Музыка игры кодом (docs/35-stage4-plan.md Р180, бриф design/art/sound.md §4):
 * три круга — лобби, пульс забега и слой босса — сочиняются здесь нотами и
 * рендерятся в файлы. Генератора нет: пьеса — данные, её можно перечитать,
 * поправить и пересобрать, а права целиком наши.
 *
 *   node design/art/src/music.mjs
 *
 * Результат — packages/app-shell/src/audio/music/{lobby,run,boss}.{ogg,m4a} и
 * tracks.json; черновые WAV — в design/art/out/music/ (не в git). Нужен ffmpeg
 * с libopus.
 *
 * Почему не надоест, как процедурная музыка v0.4.0 (docs/31 §5): круг —
 * минута с лишним, а не такт; внутри круга три раздела с разной плотностью;
 * мелодии-крючка нет — гусли играют фигуры аккорда, а не тему.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RATE,
  add,
  bigDrum,
  biquad,
  choirVoice,
  drone,
  envelope,
  foldLoop,
  frameDrum,
  freeverb,
  gusli,
  midiHz,
  mixInto,
  multiply,
  peak,
  place,
  rms,
  rng,
  saw,
  scale,
  shaker,
  sine,
  track,
  wav,
} from "./music-dsp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const DRAFT = join(HERE, "../out/music");
const TARGET = join(ROOT, "packages/app-shell/src/audio/music");

/** Хвост за концом круга: отзвук реверберации и долгие ноты сворачиваются в начало. */
const TAIL = 9;

/** Ре дорийский: аккорды голосами хора (около ре первой октавы) и корнем баса. */
const CHORDS = {
  Dm: { pad: [62, 65, 69], bass: 38, tones: [62, 65, 69, 74] },
  C: { pad: [60, 64, 67], bass: 36, tones: [60, 64, 67, 72] },
  G: { pad: [59, 62, 67], bass: 43, tones: [59, 62, 67, 71] },
  F: { pad: [60, 65, 69], bass: 41, tones: [60, 65, 69, 72] },
  Am: { pad: [60, 64, 69], bass: 45, tones: [57, 60, 64, 69] },
};

/** Пентатоника лада для свободных фраз гуслей в лобби: ре, фа, соль, ля, до. */
const PENTA = [62, 65, 67, 69, 72, 74, 77, 79, 81];

const dB = (v) => 20 * Math.log10(v);
const fromDb = (d) => 10 ** (d / 20);

/** Лобби: бурдон, хор и редкие фразы гуслей; 60 ударов, 16 тактов — 64 с. */
function lobby() {
  const bpm = 60;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = 16;
  const loop = bars * bar;
  const rand = rng(1601);
  const out = track(loop + TAIL);

  // Бурдон на весь круг и ещё четыре секунды: хвост ляжет на вступление следующего прохода, и шва не слышно.
  const d = drone(38, loop + 4, rand, { breath: 1 / 32, cutoff: 460 });
  multiply(d, envelope(d.length, { attack: 4, decay: 0.1, sustain: 1, hold: loop, release: 4 }));
  place(out, d, 0, 0.2, 0);

  const progression = ["Dm", "C", "Dm", "G", "F", "C", "G", "Dm"];
  const vowels = ["o", "a", "u", "o", "a", "o", "u", "a"];
  progression.forEach((name, slot) => {
    const at = slot * 2 * bar;
    CHORDS[name].pad.forEach((m, v) => {
      const voice = choirVoice(midiHz(m), 2 * bar + 3, vowels[slot], rand, { attack: 2.6, release: 3 });
      place(out, voice, at, 0.5, [-0.45, 0, 0.45][v]);
    });
    // Перебор аккорда на смене — опора уху, где мы в круге; через раз, чтобы не стать сигналом.
    if (slot % 2 === 0) {
      CHORDS[name].tones.forEach((m, k) => {
        place(out, gusli(midiHz(m), 5, rand, { brightness: 0.45, decay: 0.9982 }), at + 0.06 + k * 0.11, 0.42, -0.3 + k * 0.2);
      });
    }
    // Свободная фраза в середине слота: от трёх до шести нот вниз по пентатонике, не каждый слот.
    if (rand() < 0.72) {
      const count = 3 + Math.floor(rand() * 4);
      let index = 4 + Math.floor(rand() * (PENTA.length - 4));
      let t = at + bar + beat * Math.floor(rand() * 3);
      for (let k = 0; k < count; k++) {
        const m = PENTA[Math.max(0, Math.min(PENTA.length - 1, index))];
        place(out, gusli(midiHz(m), 4, rand, { brightness: 0.35 + rand() * 0.25, decay: 0.998 }), t + (rand() - 0.5) * 0.02, 0.36 + rand() * 0.12, rand() - 0.5);
        index -= rand() < 0.75 ? 1 : -1;
        t += beat * (rand() < 0.6 ? 0.5 : 1);
      }
    }
  });

  return { name: "lobby", bpm, bars, loop, mix: master(out, loop, { wet: 0.36, room: 0.88, damp: 0.4 }) };
}

/** Сетка шестнадцатых: время шага `step` в такте `barIndex`. */
const grid = (bar, barIndex, step) => barIndex * bar + (step * bar) / 16;

/** Одна последовательность аккордов на пульс и босса: слой босса ложится в такт и в лад. */
const RUN_PROGRESSION = ["Dm", "Dm", "C", "Dm", "Dm", "C", "G", "Dm", "F", "C", "G", "Am"];

function runShape() {
  const bpm = 90;
  const bar = (60 / bpm) * 4;
  const bars = 24;
  return { bpm, bar, bars, loop: bars * bar };
}

/** Пульс забега: бубен и бас тресилло, гусли перебором с середины, хор в последней трети. */
function run() {
  const { bpm, bar, bars, loop } = runShape();
  const rand = rng(1602);
  const out = track(loop + TAIL);

  const d = drone(38, loop + 4, rand, { breath: 1 / 21, cutoff: 380 });
  multiply(d, envelope(d.length, { attack: 4, decay: 0.1, sustain: 1, hold: loop, release: 4 }));
  place(out, d, 0, 0.14, 0);

  for (let b = 0; b < bars; b++) {
    const section = Math.floor(b / 8);
    const chord = CHORDS[RUN_PROGRESSION[Math.floor(b / 2)]];
    const lastOfSection = b % 8 === 7;

    // Бас: тресилло 3+3+2 на корне, квинта в конце второго такта слота.
    const steps = section === 1 ? [0, 6, 12, 14] : [0, 6, 12];
    for (const s of steps) {
      const m = s === 14 || (b % 2 === 1 && s === 12) ? chord.bass + 7 : chord.bass;
      const n = Math.round(0.3 * RATE);
      const body = add(sine(n, midiHz(m)), biquad(saw(n, midiHz(m), rand()), "lowpass", (x) => 900 * (1 - x) + 120, 0.8), 0.45);
      // Насыщение даёт басу обертона: основной тон 73 Гц телефон не сыграет, а вторую-третью гармонику — да.
      for (let i = 0; i < n; i++) body[i] = Math.tanh(body[i] * 2.6) * 0.7;
      multiply(body, envelope(n, { attack: 0.004, decay: 0.22, sustain: 0.35, hold: 0.24, release: 0.06 }));
      place(out, body, grid(bar, b, s), s === 0 ? 0.5 : 0.4, 0);
    }

    // Бубен: низ на тресилло, звон на слабые доли; к третьему разделу — гуще.
    const lows = section === 2 ? [0, 6, 8, 12] : [0, 6, 12];
    for (const s of lows) place(out, frameDrum(rand, { low: 1, jingle: 0.12 }), grid(bar, b, s), s === 0 ? 0.55 : 0.42, -0.05);
    for (const s of [4, 12]) place(out, frameDrum(rand, { low: 0.25, jingle: 0.55, dur: 0.35, pitch: 1.3 }), grid(bar, b, s) + 0.004, 0.32, 0.15);
    for (const s of [2, 10, 14]) place(out, frameDrum(rand, { low: 0.3, jingle: 0.2, dur: 0.2, pitch: 1.5 }), grid(bar, b, s), 0.12, 0.1);
    if (lastOfSection) {
      for (let s = 12; s < 16; s++) place(out, frameDrum(rand, { low: 0.7, jingle: 0.3, dur: 0.3, pitch: 1.15 }), grid(bar, b, s), 0.2 + (s - 12) * 0.07, -0.1);
    }

    // Шейкер шестнадцатыми — со второго раздела.
    if (section >= 1) {
      for (let s = 0; s < 16; s++) {
        const jitter = (rand() - 0.5) * 0.008;
        place(out, shaker(rand), grid(bar, b, s) + jitter, s % 4 === 2 ? 0.16 : 0.09, 0.35);
      }
    }

    // Гусли перебором: в первом разделе четвертями, во втором шестнадцатыми, в третьем — восьмыми и выше,
    // чтобы уступить хору. Середина нужна с первого такта: динамик телефона бас почти не играет.
    {
      const figure = [0, 1, 2, 3, 2, 1, 2, 1];
      const rotate = (b * 3) % figure.length;
      const step = [4, 1, 2][section];
      const lift = section === 2 ? 12 : 0;
      for (let s = 0; s < 16; s += step) {
        const m = chord.tones[figure[(s / step + rotate) % figure.length]] + lift;
        const accent = s % 4 === 0 ? 1 : 0.7;
        place(out, gusli(midiHz(m), 1.6, rand, { brightness: 0.55, decay: 0.9965 }), grid(bar, b, s) + (rand() - 0.5) * 0.006, (section === 0 ? 0.3 : 0.4) * accent, -0.35 + (s / 16) * 0.7);
      }
    }

    // Удар-веха в начале раздела: ухо знает, где круг, и не ищет конец.
    if (b % 8 === 0) {
      const tom = multiply(add(sine(Math.round(1.2 * RATE), 55), biquad(sine(Math.round(1.2 * RATE), 82), "lowpass", 300), 0.5), envelope(Math.round(1.2 * RATE), { attack: 0.002, decay: 1.1, sustain: 0, release: 0.05 }));
      place(out, tom, grid(bar, b, 0), 0.35, 0);
    }
  }

  // Хор в последней трети, слотами по два такта.
  for (let slot = 8; slot < 12; slot++) {
    CHORDS[RUN_PROGRESSION[slot]].pad.forEach((m, v) => {
      place(out, choirVoice(midiHz(m), 2 * bar + 2, "a", rand, { attack: 1.4, release: 2 }), slot * 2 * bar, 0.32, [-0.5, 0, 0.5][v]);
    });
  }

  return { name: "run", bpm, bars, loop, mix: rotate(master(out, loop, { wet: 0.22, room: 0.8, damp: 0.45 }), -SEAM_STEPS * (bar / 16)) };
}

/** Слой босса поверх пульса: большой барабан, медь на корнях, тремоло струн, хор в малую секунду. */
function boss() {
  const { bpm, bar, bars, loop } = runShape();
  const rand = rng(1603);
  const out = track(loop + TAIL);

  for (let b = 0; b < bars; b++) {
    const chord = CHORDS[RUN_PROGRESSION[Math.floor(b / 2)]];
    const section = Math.floor(b / 8);

    // Большой барабан на первую и третью доли; в третьем разделе — ещё синкопа.
    const hits = section === 2 ? [0, 8, 11, 14] : [0, 8];
    for (const s of hits) place(out, bigDrum(rand, { dur: 1.1 }), grid(bar, b, s), s === 0 ? 0.7 : 0.5, 0);
    if (b % 4 === 3) {
      for (let s = 12; s < 16; s++) place(out, bigDrum(rand, { dur: 0.5, gain: 0.6 }), grid(bar, b, s), 0.25 + (s - 12) * 0.08, (s % 2) * 0.3 - 0.15);
    }

    // Медь: корень и квинта на первую долю слота и короткий отголосок на «и» второй доли.
    if (b % 2 === 0) {
      for (const [s, len, g] of [
        [0, 0.9, 0.36],
        [6, 0.35, 0.24],
        [16 + 0, 0.9, 0.3],
      ]) {
        for (const m of [chord.bass + 12, chord.bass + 19]) {
          const n = Math.round(len * RATE);
          const tone = new Float32Array(n);
          for (const cents of [-7, 0, 6]) add(tone, saw(n, midiHz(m), rand(), cents), 0.33);
          const shaped = biquad(tone, "lowpass", (x) => 300 + 1700 * Math.exp(-x * 4), 1.1);
          multiply(shaped, envelope(n, { attack: 0.03, decay: len * 0.6, sustain: 0.45, hold: len * 0.8, release: len * 0.2 }));
          place(out, shaped, grid(bar, b, s), g, m === chord.bass + 12 ? -0.2 : 0.2);
        }
      }
    }
  }

  // Тремоло струн: держат аккорд слота, дрожат шестнадцатыми.
  for (let slot = 0; slot < 12; slot++) {
    const chord = CHORDS[RUN_PROGRESSION[slot]];
    const len = 2 * bar + 0.4;
    const n = Math.round(len * RATE);
    const tremoloHz = (bpm / 60) * 4;
    chord.pad.forEach((m, v) => {
      const body = biquad(add(saw(n, midiHz(m - 12), rand(), -5), saw(n, midiHz(m - 12), rand(), 5)), "lowpass", 1500, 0.7);
      for (let i = 0; i < n; i++) body[i] *= 0.55 + 0.45 * Math.cos((2 * Math.PI * tremoloHz * i) / RATE);
      multiply(body, envelope(n, { attack: 0.25, decay: 0.2, sustain: 1, hold: len - 0.4, release: 0.4 }));
      place(out, body, slot * 2 * bar, 0.1, [-0.6, 0, 0.6][v]);
    });
  }

  // Хор: малая секунда внутри лада (ми — фа, си — до) нарастает каждые четыре такта — тревога без чужих нот.
  for (let b = 0; b < bars; b += 4) {
    const name = RUN_PROGRESSION[Math.floor(b / 2)];
    const pair = name === "G" ? [71, 72] : [76, 77];
    pair.forEach((m, v) => {
      place(out, choirVoice(midiHz(m), 4 * bar, "a", rand, { attack: 3.2, release: 2.4 }), b * bar, 0.22, v === 0 ? -0.4 : 0.4);
    });
  }

  return { name: "boss", bpm, bars, loop, mix: rotate(master(out, loop, { wet: 0.25, room: 0.82, damp: 0.4 }), -SEAM_STEPS * (bar / 16)) };
}

/**
 * Шов круга — на пятой шестнадцатой после первой доли: там тише всего у
 * пульса и босса сразу. Кодеры портят край файла, и громкий удар на краю
 * щёлкнул бы на шве (замерено: у босса скачок до трёх раз выше обычного, на
 * пятой шестнадцатой — меньше половины). Пульс и босс сдвинуты одинаково и
 * остаются в такт друг другу; где первая доля — `firstBeatSec` в tracks.json.
 */
const SEAM_STEPS = 5;

function rotate(stereo, sec) {
  const shift = Math.round(sec * RATE);
  return stereo.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[(i - shift + ch.length) % ch.length];
    return out;
  });
}

/** Реверберация по всей дорожке, затем хвост — в начало круга. */
function master(dry, loop, reverb) {
  const wet = freeverb(dry, reverb);
  const sum = dry.map((ch, c) => ch.map((v, i) => v + wet[c][i]));
  // Нижний срез под 40 Гц: телефон их не сыграет, а кодеку они стоят битов.
  const cleaned = sum.map((ch) => biquad(ch, "highpass", 40, 0.7));
  return foldLoop(cleaned, loop);
}

/** Громкость по среднеквадратичному: лобби тише пульса, пульс с боссом не выходит за −1 дБ. */
function level(tracks) {
  const byName = Object.fromEntries(tracks.map((t) => [t.name, t]));
  scale(byName.lobby.mix, fromDb(-25) / rms(byName.lobby.mix));
  scale(byName.run.mix, fromDb(-20) / rms(byName.run.mix));
  scale(byName.boss.mix, fromDb(-21) / rms(byName.boss.mix));
  const together = byName.run.mix.map((ch, c) => ch.map((v, i) => v + byName.boss.mix[c][i]));
  const over = peak(together) / fromDb(-1);
  if (over > 1) for (const t of [byName.run, byName.boss]) scale(t.mix, 1 / over);
  for (const t of tracks) {
    const p = peak(t.mix);
    if (p > fromDb(-1)) scale(t.mix, fromDb(-1) / p);
  }
  return { together: byName.run.mix.map((ch, c) => ch.map((v, i) => v + byName.boss.mix[c][i])) };
}

function encode(name, wavPath) {
  const ogg = join(TARGET, `${name}.ogg`);
  const m4a = join(TARGET, `${name}.m4a`);
  // Метаданные кодера убраны: без них файл повторяется бит в бит от запуска к запуску.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wavPath, "-c:a", "libopus", "-b:a", "56k", "-vbr", "on", "-compression_level", "10", "-application", "audio", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", ogg]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wavPath, "-c:a", "aac", "-b:a", "60k", "-movflags", "+faststart", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", m4a]);
  return { ogg: statSync(ogg).size, m4a: statSync(m4a).size };
}

mkdirSync(DRAFT, { recursive: true });
mkdirSync(TARGET, { recursive: true });
const tracks = [lobby(), run(), boss()];
const { together } = level(tracks);
const dither = rng(7);
const report = [];
const meta = {};
for (const t of tracks) {
  const wavPath = join(DRAFT, `${t.name}.wav`);
  writeFileSync(wavPath, wav(t.mix, dither));
  const size = encode(t.name, wavPath);
  meta[t.name] = { seconds: Number(t.loop.toFixed(3)), bpm: t.bpm, bars: t.bars, beatsPerBar: 4, firstBeatSec: t.name === "lobby" ? 0 : Number((t.loop - SEAM_STEPS * (60 / t.bpm / 4)).toFixed(4)) };
  report.push({ track: t.name, sec: t.loop.toFixed(1), rms: dB(rms(t.mix)).toFixed(1), peak: dB(peak(t.mix)).toFixed(1), ogg: `${(size.ogg / 1024).toFixed(0)} КБ`, m4a: `${(size.m4a / 1024).toFixed(0)} КБ` });
}
writeFileSync(join(DRAFT, "run+boss.wav"), wav(together, dither));
writeFileSync(join(TARGET, "tracks.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.table(report);
console.log(`пульс + босс: пик ${dB(peak(together)).toFixed(1)} дБ, среднее ${dB(rms(together)).toFixed(1)} дБ`);
