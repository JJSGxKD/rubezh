import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CONTENT_HASH } from "../src/content/hash";
import { decodeInputLog, InputLogWriter } from "../src/game/diagnostics/input-log";
import { replayRecording } from "../src/game/diagnostics/replay";
import { buildRunProof, packRunProof, RUN_PROOF_MAX_PACKED_BYTES } from "../src/game/diagnostics/run-proof";
import { CHECKPOINT_TICKS, openRunRecorder } from "../src/game/diagnostics/run-recorder";
import { createRunWorld } from "../src/game/run-world";
import { captureWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { DIRECTION_CODES, IDLE_CODE } from "../src/game/sim/input-code";
import { RUN_PROOF_SCHEMA, type RunProof } from "../src/run-api";
import { circling } from "./helpers/recorded-run";
import { runWithProof } from "./helpers/proof-run";

// Запись для проверки (docs/28-diagnostics.md §3.4, tasks/T-0316): лёгкая запись
// у каждого забега — зерно, ввод, выборы и контрольные суммы, — которую сервер
// повторяет и сверяет. Она переживает продолжение из снимка.

/**
 * Seed, который при круговании доживает до конца сценария. Выбран по контенту:
 * правка врагов или оружия может уронить игрока раньше — тогда тест скажет об
 * этом прямо, и seed подбирается заново, а не ослабляется проверка.
 */
const SEED = 2;
const SLOW = { timeout: 120_000 };

function must(proof: RunProof | null): RunProof {
  if (proof === null) throw new Error("записи для проверки нет");
  return proof;
}

describe("запись для проверки: забег без продолжения", () => {
  it("повторяется до свёртки мира, и итог повтора равен итогу записи", SLOW, () => {
    const run = runWithProof({ seed: SEED, maxTicks: CHECKPOINT_TICKS + 600, steer: circling(150) });
    const proof = must(run.proof);

    expect(proof.schema).toBe(RUN_PROOF_SCHEMA);
    expect(proof.input.ticks).toBe(run.world.stats.tick);
    expect(proof.checkpoints).toHaveLength(1);
    expect(proof.choices.length).toBeGreaterThan(0);
    const outcome = replayRecording(proof);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
    expect(outcome.actual).toEqual(proof.result);
  });

  it("несёт только то, что задаёт исход: ни кадров, ни событий, ни производительности, ни видеоадаптера", SLOW, () => {
    const proof = must(runWithProof({ seed: SEED, maxTicks: 900, steer: circling(150) }).proof);

    expect(Object.keys(proof).sort()).toEqual(
      [
        "checkpoints",
        "choices",
        "contentHash",
        "continues",
        "deviceClass",
        "difficultyId",
        "input",
        "loadout",
        "mapId",
        "mode",
        "result",
        "runId",
        "schema",
        "seed",
        "startingWeaponId",
        "unitScale",
      ].sort(),
    );
    expect(proof.contentHash).toBe(CONTENT_HASH);
    expect(proof.mode).toBe("endless");
    expect(proof.deviceClass).toBe("standard");
    expect(proof.loadout).toEqual({ modifiers: {}, boosts: [] });
  });

  it("забег со вторым шансом: тики продолжений в записи, повтор совпадает", SLOW, () => {
    // Стоящий на месте игрок на «Сложной» гибнет быстро — дважды за один забег.
    const run = runWithProof({ seed: 99, maxTicks: 60 * CHECKPOINT_TICKS, difficultyId: "hard", steer: () => null, continues: true });
    const proof = must(run.proof);

    expect(proof.continues.length).toBeGreaterThan(0);
    expect(proof.result.deathCause).not.toBeNull();
    expect(replayRecording(proof).verdict).toBe("match");
  });

  it("снаряжение, уровень аккаунта и слабое устройство: набор в записи, класс устройства — отдельным полем", SLOW, () => {
    const loadout = { modifiers: { damage: 0.2, maxHp: 20 }, boosts: ["insight"], accountLevel: 9, deviceClass: "light" as const };
    const proof = must(runWithProof({ seed: SEED, maxTicks: 1_200, steer: circling(150), loadout }).proof);

    // Схема приёмника держит класс устройства на верхнем уровне, а в наборе его нет.
    expect(proof.loadout).toEqual({ modifiers: { damage: 0.2, maxHp: 20 }, boosts: ["insight"], accountLevel: 9 });
    expect(proof.deviceClass).toBe("light");
    expect(replayRecording(proof).verdict).toBe("match");
    // Без верхнего поля повтор шёл бы с другим потолком врагов — и не сошёлся бы.
    expect(replayRecording({ ...proof, deviceClass: "standard" }).verdict).toBe("mismatch");
  });

  it("забег с записью и без неё побитно одинаков", SLOW, () => {
    const options = { seed: SEED, maxTicks: CHECKPOINT_TICKS + 300, steer: circling(150) };
    const recorded = runWithProof(options);
    const bare = runWithProof({ ...options, record: false });

    expect(checksumWorld(recorded.world)).toBe(checksumWorld(bare.world));
    expect(JSON.stringify(captureWorld(recorded.runWorld.world, recorded.runWorld.spawner))).toBe(
      JSON.stringify(captureWorld(bare.runWorld.world, bare.runWorld.spawner)),
    );
  });

  it("рядом с полной записью проверка — её подмножество: тот же ввод, выборы, продолжения и свёртки", SLOW, () => {
    const run = runWithProof({ seed: SEED, maxTicks: CHECKPOINT_TICKS + 300, steer: circling(150), full: true });
    const proof = must(run.proof);
    const recording = run.recording;

    expect(recording).not.toBeNull();
    expect(proof.input).toEqual(recording?.input);
    expect(proof.choices).toEqual(recording?.choices);
    expect(proof.continues).toEqual(recording?.continues);
    expect(proof.checkpoints).toEqual(recording?.checkpoints);
    expect(proof.result).toEqual(recording?.result);
    expect(recording?.events.length).toBeGreaterThan(0);
    // Без полной записи рекордер не собирает ни событий, ни кадров.
    const light = runWithProof({ seed: SEED, maxTicks: 300, steer: circling(150) });
    expect(light.recording).toBeNull();
  });

  it("забег разработчика не повторить: причина `dev`, записи и снимка записи нет", () => {
    const run = runWithProof({ seed: SEED, maxTicks: 300, steer: circling(150), dev: true });

    expect(run.recorder?.blocker).toBe("dev");
    expect(run.proof).toBeNull();
    expect(run.recorder?.draft(run.world)).toBeNull();
  });

  it("лог ввода, не влезший в потолок, — причина `input_overflow`, записи нет", () => {
    const run = runWithProof({ seed: SEED, maxTicks: 3_000, steer: (tick) => [Math.cos(tick * 2.3), Math.sin(tick * 3.1)], inputLogBytes: 64 });

    expect(run.recorder?.blocker).toBe("input_overflow");
    expect(run.proof).toBeNull();
  });
});

describe("запись для проверки: продолжение из снимка", () => {
  const AT = 3 * CHECKPOINT_TICKS - 457;
  const THROUGH = 3 * CHECKPOINT_TICKS + 900;

  it("снимок на третьей минуте → продолжение: запись покрывает весь забег, повтор совпадает, `resumed` нет", SLOW, () => {
    const run = runWithProof({ seed: SEED, maxTicks: THROUGH, steer: circling(150), snapshotAtTick: AT });
    const proof = must(run.proof);

    expect(run.snapshotTick).toBeGreaterThanOrEqual(AT);
    expect(run.world.stats.tick).toBe(THROUGH);
    expect(run.recorder?.blocker).toBeNull();
    // Лог с нулевого тика, а не с тика снимка.
    expect(proof.input.ticks).toBe(THROUGH);
    expect(decodeInputLog(proof.input)).toHaveLength(THROUGH);
    // Выборы до снимка не потерялись.
    expect(proof.choices.some(([tick]) => tick < AT)).toBe(true);
    // Свёртка в тике снимка и минутные: 1-я, 2-я, 3-я.
    expect(proof.checkpoints.map(([tick]) => tick)).toContain(run.snapshotTick);
    expect(proof.checkpoints.filter(([tick]) => tick % CHECKPOINT_TICKS === 0)).toHaveLength(3);

    const outcome = replayRecording(proof);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
    expect(outcome.actual).toEqual(proof.result);
  });

  it("продолженный забег даёт тот же исход, что непрерванный", SLOW, () => {
    const through = runWithProof({ seed: SEED, maxTicks: THROUGH, steer: circling(150), snapshotAtTick: AT });
    const straight = runWithProof({ seed: SEED, maxTicks: THROUGH, steer: circling(150) });

    expect(must(through.proof).result.checksum).toBe(must(straight.proof).result.checksum);
    expect(must(through.proof).choices).toEqual(must(straight.proof).choices);
    // Разбитая снимком серия одинаковых кодов читается так же, как цельная.
    expect(Array.from(decodeInputLog(must(through.proof).input))).toEqual(Array.from(decodeInputLog(must(straight.proof).input)));
  });

  it("снимок сразу после выбора улучшения, на том же тике, тоже повторяется", SLOW, () => {
    const run = runWithProof({ seed: SEED, maxTicks: 1_800, steer: circling(150), snapshotAfterChoice: true });
    const proof = must(run.proof);

    expect(run.snapshotTick).not.toBeNull();
    // Свёртка снимка снята уже после выбора, а повтор сверяет её и до выбора, и после.
    expect(proof.checkpoints.map(([tick]) => tick)).toContain(run.snapshotTick);
    const outcome = replayRecording(proof);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
  });

  it("свёртка в тике снимка сверяется: подмена даёт расхождение ровно на этом тике", SLOW, () => {
    const run = runWithProof({ seed: SEED, maxTicks: THROUGH, steer: circling(150), snapshotAtTick: AT });
    const proof = must(run.proof);
    const checkpoints = proof.checkpoints.map(([tick, sum]): [number, number] => (tick === run.snapshotTick ? [tick, sum ^ 1] : [tick, sum]));

    const outcome = replayRecording({ ...proof, checkpoints });
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.divergedAtTick).toBe(run.snapshotTick);
  });

  it("снимок в любой момент даёт ту же запись: момент снимка исход не меняет", SLOW, () => {
    const first = runWithProof({ seed: SEED, maxTicks: 1_500, steer: circling(150), snapshotAtTick: 700 });
    const second = runWithProof({ seed: SEED, maxTicks: 1_500, steer: circling(150), snapshotAtTick: 1_100 });

    expect(must(first.proof).input.ticks).toBe(1_500);
    expect(must(second.proof).input.ticks).toBe(1_500);
    expect(must(first.proof).result.checksum).toBe(must(second.proof).result.checksum);
  });

  it("забег со вторым шансом, продолженный из снимка, повторяется", SLOW, () => {
    const run = runWithProof({
      seed: 99,
      maxTicks: 60 * CHECKPOINT_TICKS,
      difficultyId: "hard",
      steer: () => null,
      continues: true,
      snapshotAtTick: 300,
    });
    const proof = must(run.proof);

    expect(proof.continues.length).toBeGreaterThan(0);
    expect(replayRecording(proof).verdict).toBe("match");
  });

  it("снимок прошлой сборки без записи — `resumed`, как раньше: записи нет", () => {
    const run = runWithProof({ seed: SEED, maxTicks: 900, steer: circling(150), snapshotAtTick: 400, dropProofFromSnapshot: true });

    expect(run.recorder?.blocker).toBe("resumed");
    expect(run.proof).toBeNull();
  });

  it("битая запись в снимке не роняет забег: причина `resumed`", () => {
    const broken: ((snapshot: { proof?: unknown }) => void)[] = [
      (snapshot) => (snapshot.proof = "мусор"),
      (snapshot) => (snapshot.proof = { ...(snapshot.proof as object), input: { encoding: "rle-v1", ticks: 5, data: "@@@@", truncated: false } }),
      // Запись не про этот забег: тиков столько, сколько не прошёл мир.
      (snapshot) => (snapshot.proof = { ...(snapshot.proof as { input: object }), input: { ...(snapshot.proof as { input: object }).input, ticks: 7 } }),
      (snapshot) => (snapshot.proof = { ...(snapshot.proof as object), choices: [[1, 2]] }),
      // Мир считал в других пикселях — повтор от зерна с прежним масштабом разошёлся бы.
      (snapshot) => (snapshot.proof = { ...(snapshot.proof as object), unitScale: 3 }),
    ];
    for (const tamperSnapshot of broken) {
      const run = runWithProof({ seed: SEED, maxTicks: 900, steer: circling(150), snapshotAtTick: 400, tamperSnapshot });
      expect(run.recorder?.blocker).toBe("resumed");
      expect(run.proof).toBeNull();
    }
  });
});

describe("запись для проверки: подмена", () => {
  it("другой настоящий вариант вместо выбора — расхождение на свёртке или итоге", SLOW, () => {
    const run = runWithProof({ seed: SEED, maxTicks: CHECKPOINT_TICKS + 300, steer: circling(150) });
    const proof = must(run.proof);
    const [tick, chosen] = proof.choices[0];
    const alternative = run.offers.find((offer) => offer.tick === tick)?.ids.find((id) => id !== chosen);
    expect(alternative).toBeDefined();

    const tampered: RunProof = { ...proof, choices: [[tick, alternative ?? ""], ...proof.choices.slice(1)] };
    const outcome = replayRecording(tampered);
    expect(outcome.verdict).toBe("mismatch");
    // Расхождение не раньше подменённого выбора.
    expect(outcome.divergedAtTick === null || outcome.divergedAtTick >= tick).toBe(true);
  });

  it("выбор, которого не было в предложении, — расхождение с тиком выбора", SLOW, () => {
    const proof = must(runWithProof({ seed: SEED, maxTicks: CHECKPOINT_TICKS, steer: circling(150) }).proof);
    const [tick] = proof.choices[0];

    const outcome = replayRecording({ ...proof, choices: [[tick, "not_an_option"], ...proof.choices.slice(1)] });
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.divergedAtTick).toBe(tick);
    expect(outcome.reason).toContain("not_an_option");
  });

  it("завышенное время в итоге при честном вводе — расхождение итога", SLOW, () => {
    const proof = must(runWithProof({ seed: SEED, maxTicks: 1_200, steer: circling(150) }).proof);

    const outcome = replayRecording({ ...proof, result: { ...proof.result, survivalSec: proof.result.survivalSec + 120 } });
    expect(outcome.verdict).toBe("mismatch");
  });

  it("чужой хэш контента, неповторимую и битую запись повтор не принимает", () => {
    const proof = must(runWithProof({ seed: SEED, maxTicks: 200, steer: circling(150) }).proof);

    expect(replayRecording(proof, "другой-хэш").verdict).toBe("content_mismatch");
    expect(replayRecording({ ...proof, replayBlocker: "resumed" }).verdict).toBe("not_replayable");
    expect(replayRecording({ ...proof, input: { ...proof.input, data: "????" } }).verdict).toBe("broken");
  });
});

describe("запись для проверки: размер и сжатие", () => {
  function unpack(payload: string): unknown {
    return JSON.parse(gunzipSync(Buffer.from(payload, "base64")).toString("utf8"));
  }

  /** Запись из `ticks` шагов случайного ввода: сжимается хуже всего. */
  function noisyProof(ticks: number, inputLogBytes: number): RunProof {
    const { world } = createRunWorld({ seed: 1, mapId: "", difficultyId: "normal", unitScale: 2 });
    const recorder = openRunRecorder({ world, runId: "noisy", seed: 1, contentHash: CONTENT_HASH, startingWeaponId: "spark", unitScale: 2, inputLogBytes });
    let state = 7;
    for (let tick = 1; tick <= ticks; tick++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      world.stats.tick = tick;
      recorder.stepped(state % 3 === 0 ? IDLE_CODE : state % DIRECTION_CODES, world);
    }
    return must(recorder.proof(world, null));
  }

  it("сжимается gzip и кодируется base64: распакованная запись равна исходной", async () => {
    const proof = must(runWithProof({ seed: SEED, maxTicks: 1_200, steer: circling(150) }).proof);

    const packed = await packRunProof(proof);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    expect(packed.payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(packed.bytes).toBeLessThanOrEqual(RUN_PROOF_MAX_PACKED_BYTES);
    expect(unpack(packed.payload)).toEqual(proof);
    expect(Buffer.from(packed.payload, "base64").byteLength).toBe(packed.bytes);
  });

  it("десять минут худшего честного ввода укладываются в 64 КБ после сжатия", async () => {
    // Потолок лога ввода (48 КБ) стоит так, что честный забег в потолок упереться не может.
    const proof = noisyProof(10 * CHECKPOINT_TICKS, 48_000);

    const packed = await packRunProof(proof);
    expect(packed.ok).toBe(true);
    if (packed.ok) expect(packed.bytes).toBeLessThanOrEqual(RUN_PROOF_MAX_PACKED_BYTES);
  });

  it("запись больше 64 КБ после сжатия — `proof_overflow`, отправлять нечего", async () => {
    const proof = noisyProof(60_000, 400_000);

    expect(proof.input.truncated).toBe(false);
    expect(await packRunProof(proof)).toEqual({ ok: false, blocker: "proof_overflow" });
  });

  it("сборка записи копирует ход, а не отдаёт ссылки на рекордер", () => {
    const { world } = createRunWorld({ seed: 1, mapId: "", difficultyId: "normal", unitScale: 2 });
    const writer = new InputLogWriter();
    writer.push(3);
    const progress = { input: writer.finish(), choices: [[10, "a"]] as [number, string][], continues: [5], checkpoints: [[3600, 1]] as [number, number][] };
    const proof = buildRunProof(
      { runId: "r", seed: 1, mapId: world.mapId, difficultyId: "normal", startingWeaponId: "spark", contentHash: "h", unitScale: 2, replayBlocker: null },
      progress,
      { ticks: 1, survivalSec: 0, level: 1, enemiesKilled: 0, deathCause: null, checksum: 0 },
    );

    progress.choices.push([11, "b"]);
    expect(proof.choices).toEqual([[10, "a"]]);
  });
});

describe("лог ввода: снимок и продолжение", () => {
  it("снимок не меняет писателя, а продолжение дописывает тот же лог", () => {
    const codes = [IDLE_CODE, 10, 10, 11, 12, 12, 12, IDLE_CODE, 40, 40];
    const straight = new InputLogWriter();
    for (const code of codes) straight.push(code);

    const first = new InputLogWriter();
    for (const code of codes.slice(0, 5)) first.push(code);
    const snapshot = first.snapshot();
    // Снимок — состояние на момент снимка: писатель после него пишет как ни в чём не бывало.
    for (const code of codes.slice(5)) first.push(code);
    expect(Array.from(decodeInputLog(first.finish()))).toEqual(codes);

    const resumed = InputLogWriter.restore(snapshot);
    for (const code of codes.slice(5)) resumed.push(code);
    expect(Array.from(decodeInputLog(resumed.finish()))).toEqual(Array.from(decodeInputLog(straight.finish())));
  });

  it("снимок из обрезанного лога остаётся обрезанным, а битый — не читается", () => {
    const writer = new InputLogWriter(64);
    for (let i = 0; i < 1_000; i++) writer.push((i * 37) % DIRECTION_CODES);
    const snapshot = writer.snapshot();

    expect(snapshot.truncated).toBe(true);
    expect(InputLogWriter.restore(snapshot).truncated).toBe(true);
    expect(() => InputLogWriter.restore({ encoding: "rle-v1", ticks: 9, data: "@@@@", truncated: false })).toThrow();
  });
});
